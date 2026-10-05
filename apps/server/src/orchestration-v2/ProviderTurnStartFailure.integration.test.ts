import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as CodexProtocol from "effect-codex-app-server/protocol";
import { makeInMemoryStdio } from "../../../../packages/effect-codex-app-server/src/_internal/stdio.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  ProviderAdapterEnsureThreadError,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "./ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const parentThreadId = ThreadId.make("thread:start-failure-parent");
const startError = "required MCP servers failed to initialize: serena: Broken pipe";

const failedChildTest = (stalledTransport: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("provider-turn-start-failure");
      const wake = yield* Deferred.make<ProviderContinuationRequest>();
      const childEnsureEntered = yield* Deferred.make<void>();
      let childEnsureAttempts = 0;
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const { stdio } = yield* makeInMemoryStdio();
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
              events: Stream.never,
              ensureThread: ({ threadId }) => {
                if (threadId !== parentThreadId) {
                  childEnsureAttempts += 1;
                  if (stalledTransport)
                    return Deferred.succeed(childEnsureEntered, undefined).pipe(
                      Effect.andThen(transport.request("thread/start", { threadId })),
                      Effect.flatMap(() => Effect.die("The stalled peer cannot reply")),
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterEnsureThreadError({ driver, threadId, cause }),
                      ),
                    );
                  return Effect.fail(
                    new ProviderAdapterEnsureThreadError({
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
              startTurn: () => Effect.void,
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
          projectId: ProjectId.make("project:start-failure"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
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
          task: "Inspect the migration",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId))
          .subagents[0]!.childThreadId!;

        // Every attempt but the last leaves the run starting so the worker retries.
        if (stalledTransport) {
          const drain = yield* worker.drain().pipe(Effect.forkScoped);
          yield* Deferred.await(childEnsureEntered);
          yield* TestClock.adjust("60 seconds");
          yield* Fiber.join(drain);
        } else {
          yield* worker.drain();
        }
        assert.equal(childEnsureAttempts, 1);
        assert.equal(
          (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.status,
          "starting",
        );
        for (let retry = 0; retry < 4; retry += 1) {
          yield* TestClock.adjust("1 minute");
          yield* worker.drain();
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
        if (stalledTransport) assert.include(task.result ?? "", "timed out");
        else assert.equal(task.result, startError);
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "provider-turn-start-failure" },
            makeSingleLayer(adapter),
            { runEffectWorker: false },
          ).pipe(
            Layer.provide(
              Layer.succeed(ProviderContinuationRequests, {
                offer: (request) => Deferred.succeed(wake, request).pipe(Effect.asVoid),
                take: Effect.never,
              }),
            ),
          ),
        ),
      );
    }),
  );

it.effect.each([false, true])(
  "a delegated child fails and wakes its parent (stalled transport: %s)",
  failedChildTest,
);
