import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as CodexProtocol from "effect-codex-app-server/protocol";
import { CodexAppServerInputStreamEndedError } from "effect-codex-app-server/errors";
import { makeInMemoryStdio } from "../../../../packages/effect-codex-app-server/src/_internal/stdio.ts";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as EventSink from "./EventSink.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { reviewIssue, reviewRead } from "./ThreadLaunchService.testHarness.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const parentThreadId = ThreadId.make("thread:start-failure-parent");
const projectId = ProjectId.make("project:start-failure");
const issue = reviewIssue(1);
const startError = "required MCP servers failed to initialize: serena: Broken pipe";

const failedChildTest = (
  mode:
    | "refused"
    | "stalled"
    | "wedged"
    | "recovers"
    | "exhausted"
    | "limited"
    | "persistent"
    | "disconnect",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("provider-turn-start-failure");
      const wake = yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const childStartRequests = yield* Queue.unbounded<string>();
      const ensureEntered = yield* Deferred.make<void>();
      let childEnsureAttempts = 0;
      let childTurns = 0;
      let lastChildTurn:
        | Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0]
        | undefined;
      const startsNormally = mode !== "refused" && mode !== "stalled";
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const { stdio, output } = yield* makeInMemoryStdio();
            if (mode === "stalled") {
              yield* Stream.fromQueue(output).pipe(
                Stream.runForEach((request) => Queue.offer(childStartRequests, request)),
                Effect.forkScoped,
              );
            }
            const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) => {
                if (threadId !== parentThreadId && mode === "wedged") {
                  childEnsureAttempts += 1;
                  return Deferred.succeed(ensureEntered, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
                }
                if (threadId !== parentThreadId && !startsNormally) {
                  childEnsureAttempts += 1;
                  if (mode === "stalled")
                    return transport.request("thread/start", { threadId }).pipe(
                      Effect.flatMap(() => Effect.die("The stalled peer cannot reply")),
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterEnsureThreadError({
                            driver,
                            threadId,
                            cause,
                          }),
                      ),
                    );
                  return Effect.fail(
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver,
                      threadId,
                      cause: new Error(startError),
                    }),
                  );
                }
                return Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-parent", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                });
              },
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              // The parent turn stays running for the whole test.
              startTurn: (turn) =>
                Effect.gen(function* () {
                  if (turn.threadId === parentThreadId) return;
                  childTurns += 1;
                  lastChildTurn = turn;
                  const succeeded =
                    (mode === "recovers" || mode === "disconnect") && childTurns === 2;
                  const completedAt = yield* DateTime.now;
                  const turnId = ProviderTurnId.make(`provider-turn:retry:${turn.runId}`);
                  const common = {
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turnId,
                    runOrdinal: turn.runOrdinal,
                    threadDisposition: "reusable" as const,
                  };
                  const providerTurn = {
                    id: turnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: null,
                    ordinal: turn.providerTurnOrdinal,
                    status: "running" as const,
                    startedAt: completedAt,
                    completedAt: null,
                  };
                  yield* Queue.offerAll(events, [
                    { type: "provider_turn.updated", driver, providerTurn },
                    {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        ...providerTurn,
                        status: succeeded ? "completed" : "failed",
                        completedAt,
                      },
                    },
                    succeeded
                      ? { ...common, type: "turn.terminal", status: "completed", failure: null }
                      : {
                          ...common,
                          type: "turn.terminal",
                          status: "failed",
                          failureItemOrdinal: 1,
                          failure:
                            mode === "disconnect"
                              ? makeProviderFailure({
                                  cause: new CodexAppServerInputStreamEndedError(),
                                })
                              : {
                                  class: mode === "limited" ? "usage_limit" : "provider_error",
                                  message:
                                    mode === "persistent"
                                      ? "Model is unavailable."
                                      : childTurns === 2
                                        ? "stream disconnected before completion: error decoding response body"
                                        : "unexpected status 503 Service Unavailable",
                                  code: mode === "recovers" ? "api_error_502" : null,
                                  retryable: null,
                                },
                        },
                  ]);
                }),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };

      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:start-failure:create"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: startsNormally ? null : cwd,
          ...(startsNormally
            ? {
                repositoryOrchestration: {
                  host: issue.host,
                  repository: issue.repository,
                  repositoryId: issue.repositoryId,
                  projectId,
                  launchCommandId: CommandId.make("command:start-failure:create"),
                  revision: 1,
                  workerLimit: 4,
                  readOnlyLimit: 4,
                  publishStatusComments: false,
                  publishCloseoutComments: false,
                  suspendedIssues: [],
                },
              }
            : {}),
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:start-failure:parent-message"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-failure:parent"),
          text: "Delegate the inspection",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        assert.equal(parentRun.status, "running");

        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("command:start-failure:delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          ...(mode === "disconnect"
            ? { role: "reviewer" as const }
            : startsNormally
              ? { issue, role: "implementor" as const }
              : {}),
          task: "Inspect the migration",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          ...(mode === "wedged" ? { workspaceStrategy: { type: "root" as const } } : {}),
          createdBy: "agent",
          creationSource: "mcp",
        });
        const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId))
          .subagents[0]!.childThreadId!;

        if (mode === "wedged") {
          const slots = (yield* IssueWorkStore.IssueWorkStore).slotsInUse(parentThreadId);
          const child = orchestrator.getThreadProjection(childThreadId);
          yield* orchestrator.dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make("command:start-failure:workspace-ready"),
            threadId: childThreadId,
            runId: (yield* child).runs[0]!.id,
          });
          const drain = yield* worker.drain().pipe(Effect.forkScoped);
          yield* Deferred.await(ensureEntered);
          const starting = yield* child;
          assert.equal(starting.runs[0]?.status, "starting");
          assert.isNull(starting.runs[0]?.startedAt);
          assert.isTrue(
            starting.turnItems.some((item) => "title" in item && item.title === "Workspace ready"),
          );
          assert.equal(yield* slots, 1);

          yield* TestClock.adjust("599 seconds");
          assert.equal((yield* child).runs[0]?.status, "starting");
          yield* TestClock.adjust("1 second");
          assert.equal((yield* child).runs[0]?.status, "failed");
          yield* Fiber.join(drain);
          const request = yield* Deferred.await(wake);
          assert.equal(request.threadId, parentThreadId);
          assert.equal(request.delegatedCompletion?.parentRunId, parentRun.id);
          const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
          assert.equal(task.status, "failed");
          assert.include(task.result ?? "", "timed out after 10 minutes");
          assert.equal(yield* slots, 0);

          yield* TestClock.adjust("5 minutes");
          yield* worker.drain();
          assert.equal(childEnsureAttempts, 1);
          assert.equal(childTurns, 0);
          return;
        }

        if (startsNormally) {
          const sink = yield* EventSink.EventSinkV2;
          const parent = orchestrator.getThreadProjection(parentThreadId);
          const taskId = (yield* parent).subagents[0]!.id;
          const wakes = parent.pipe(
            Effect.map(({ messages }) =>
              messages.filter((message) => message.delegatedCompletion?.taskIds.includes(taskId)),
            ),
          );
          const beforeFailure = yield* sink.latestSequence();
          const delays =
            mode === "recovers" || mode === "disconnect"
              ? [2_000]
              : mode === "exhausted"
                ? [2_000, 4_000]
                : [];
          const drainTurn = Effect.gen(function* () {
            const sequence = yield* sink.latestSequence();
            const previousTurns = childTurns;
            yield* worker.drain();
            assert.equal(childTurns, previousTurns + 1);
            yield* sink.stream({ afterSequence: sequence, eventType: "run.updated" }).pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.threadId === childThreadId &&
                  isTerminalRunStatus(event.payload.status),
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          });
          yield* drainTurn;
          for (const delay of delays) {
            yield* orchestrator.recoverDelegatedTasks;
            assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childThreadId, taskId));
            assert.lengthOf(yield* wakes, 0);
            const previousTurns = childTurns;
            yield* TestClock.adjust(delay - 1);
            yield* worker.drain();
            assert.equal(childTurns, previousTurns);
            yield* TestClock.adjust(1);
            yield* drainTurn;
            assert.include(
              lastChildTurn?.message.text ?? "",
              "Before you repeat one that changes state",
            );
            assert.isUndefined(lastChildTurn?.restartContinuationOfRunId);
          }
          yield* worker.drain();
          yield* sink.stream({ afterSequence: beforeFailure, eventType: "message.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.threadId === parentThreadId &&
                event.type === "message.updated" &&
                event.payload.delegatedCompletion?.taskIds.includes(taskId) === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          assert.lengthOf(yield* wakes, 1);
          assert.equal(childTurns, delays.length + 1);
          const task = (yield* parent).subagents[0]!;
          assert.equal(
            task.status,
            mode === "recovers" || mode === "disconnect" ? "completed" : "failed",
          );
          return;
        }

        // Every attempt but the last leaves the run starting so the worker retries.
        const drainStart = Effect.gen(function* () {
          if (mode !== "stalled") return yield* worker.drain();
          const drain = yield* worker.drain().pipe(Effect.forkScoped);
          assert.include(yield* Queue.take(childStartRequests), '"method":"thread/start"');
          yield* TestClock.adjust("60 seconds");
          yield* Fiber.join(drain);
        });
        yield* drainStart;
        assert.equal(childEnsureAttempts, 1);
        assert.equal(
          (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.status,
          "starting",
        );
        for (let retry = 0; retry < 4; retry += 1) {
          yield* TestClock.adjust("1 minute");
          yield* drainStart;
        }
        assert.equal(childEnsureAttempts, 5);

        assert.equal(
          (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.status,
          "failed",
        );

        // The terminal-run reactor settles the task, then offers the parent wake.
        const request = yield* Deferred.await(wake);
        assert.equal(request.threadId, parentThreadId);
        assert.equal(request.delegatedCompletion?.parentRunId, parentRun.id);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        assert.equal(task.status, "failed");
        if (mode === "stalled") assert.include(task.result ?? "", "timed out");
        else assert.equal(task.result, startError);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "provider-turn-start-failure" },
            ProviderAdapterRegistry.layerSingle(adapter),
            {
              runEffectWorker: false,
              databaseLayer: SqlitePersistence.layerMemory,
              runContinuationWorker: startsNormally && mode !== "wedged",
              continueThreadsAfterServerUpdate: false,
              ...(startsNormally
                ? {
                    issueServiceLayer: Layer.mock(IssueService.IssueService)({
                      workRead: () => Effect.succeed(reviewRead(issue)),
                    }),
                  }
                : {}),
            },
          ).pipe(
            Layer.merge(IssueWorkStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
            Layer.provide(
              Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
                offer: (request) => Deferred.succeed(wake, request).pipe(Effect.asVoid),
                take: Effect.never,
              }),
            ),
          ),
        ),
      );
    }),
  );

it.effect.each(["refused", "stalled"] as const)(
  "a delegated child fails and wakes its parent after a %s start",
  failedChildTest,
);

it.effect("fails a wedged startup, wakes its parent, and releases the worker slot", () =>
  failedChildTest("wedged"),
);

it.effect.each(["recovers", "exhausted", "limited", "persistent"] as const)(
  "publishes one result when the managed worker retry %s",
  failedChildTest,
);

it.effect("retries a delegated reviewer after Codex loses its app-server connection", () =>
  failedChildTest("disconnect"),
);
