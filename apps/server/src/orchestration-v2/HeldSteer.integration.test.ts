import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { usageLimitSwitchMessageId } from "./usageLimitRecoveryPending.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const capabilities = CodexProviderCapabilitiesV2;

// The provider session starts turns without reporting them, so each test
// decides when the root provider turn goes live (or ends before it does).
const runScenario = <E>(
  name: string,
  body: (input: {
    readonly started: ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>;
    readonly steered: ReadonlyArray<MessageId>;
    readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
    readonly cwd: string;
  }) => Effect.Effect<
    void,
    E,
    Orchestrator.OrchestratorV2 | OrchestrationEffectWorkerV2 | EventSink.EventSinkV2 | Scope.Scope
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`held-steer-${name}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steered: MessageId[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
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
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) => Effect.sync(() => void started.push(turn)),
              steerTurn: (turn) => Effect.sync(() => void steered.push(turn.message.messageId)),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* body({ started, steered, events, cwd }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

const threadId = ThreadId.make("thread:held-steer");
const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    return yield* sink.stream({ afterSequence }).pipe(
      Stream.filter((stored) => predicate(stored.event)),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

/** Start the first run; its provider turn is not live yet. */
const startFirstRun = (cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:held-steer"),
      title: "Held steer",
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
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    assert.equal(run.status, "running");
    assert.equal(projection.providerTurns.length, 0);
    return run;
  });

const sendSteer = (id: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments: [],
      // What the web client sends when the server resolves command context.
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "steer",
      createdBy: "user",
      creationSource: "web",
    });
  });

const providerTurnFor = (
  turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  status: "running" | "completed",
  now: DateTime.Utc,
) => ({
  type: "provider_turn.updated" as const,
  driver,
  providerTurn: {
    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" as const },
    ordinal: turn.providerTurnOrdinal,
    status,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
  },
});

it.effect("delivers an early steer as a steer once the provider turn goes live", () =>
  runScenario("delivered", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const first = yield* startFirstRun(cwd);
      yield* sendSteer("steer");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue"),
        threadId,
        messageId: MessageId.make("message:queue"),
        text: "queue",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const held = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const heldSteer = held.find((run) => run.userMessageId === "message:steer")!;
      assert.equal(heldSteer.status, "queued");
      assert.equal(heldSteer.steerTargetRunId, first.id);
      const queued = held.find((run) => run.userMessageId === "message:queue")!;
      assert.equal(queued.steerTargetRunId, undefined);

      const promoted = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === heldSteer.id &&
          event.payload.status === "cancelled",
      );
      yield* Queue.offer(events, providerTurnFor(started[0]!, "running", yield* DateTime.now));
      yield* Fiber.join(promoted);
      yield* worker.drain();

      assert.deepEqual(steered, [MessageId.make("message:steer")]);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "user_message" && candidate.messageId === "message:steer",
      );
      assert.equal(item?.type === "user_message" ? item.inputIntent : null, "steer");
      assert.equal(item?.runId, first.id);
      // An explicit queue still waits for the turn to finish.
      assert.equal(projection.runs.find((run) => run.id === queued.id)?.status, "queued");
      assert.equal(started.length, 1);
    }),
  ),
);

it.effect("runs an early steer as a queued turn when the turn ends before going live", () =>
  runScenario("turn-ends-first", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const first = yield* startFirstRun(cwd);
      yield* sendSteer("steer");
      const now = yield* DateTime.now;
      const turn = providerTurnFor(started[0]!, "completed", now);
      const waiting = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.id &&
          event.payload.status === "waiting",
      );
      yield* Queue.offer(events, turn);
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: first.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(waiting);
      // Never starts during checkpoint capture: still queued while waiting.
      const duringCapture = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        duringCapture.runs.find((run) => run.userMessageId === "message:steer")?.status,
        "queued",
      );
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();

      assert.deepEqual(steered, []);
      assert.equal(started.length, 2);
      assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
    }),
  ),
);

it.effect("steers a live turn directly without holding it", () =>
  runScenario("live", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      yield* startFirstRun(cwd);
      const live = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* Queue.offer(events, providerTurnFor(started[0]!, "running", yield* DateTime.now));
      yield* Fiber.join(live);
      yield* sendSteer("steer");
      yield* worker.drain();

      assert.deepEqual(steered, [MessageId.make("message:steer")]);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 1);
    }),
  ),
);

it.effect.each(["live", "held", "held-switch", "promoted"] as const)(
  "completes delegated follow-ups with %s steering",
  (timing) =>
    runScenario(`delegated-${timing}`, ({ started, events, steered, cwd }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const parentRun = yield* startFirstRun(cwd);
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Check the implementation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        const original = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!;
        const childThreadId = original.childThreadId!;
        const finish = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const waiting = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === turn.runId &&
                event.payload.status === "waiting",
            );
            const completed = providerTurnFor(turn, "completed", now);
            yield* Queue.offer(events, completed);
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: completed.providerTurn.providerThreadId,
              providerTurnId: completed.providerTurn.id,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(waiting);
            yield* worker.drain();
            yield* orchestrator.recoverDelegatedTasks;
          });
        yield* finish(started[1]!);
        const published = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!;
        assert.equal(published.status, "completed");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("child-resume"),
          threadId: childThreadId,
          messageId: MessageId.make("message:child-resume"),
          text: "Continue the checks",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const resumed = started[2]!;
        const goLive = Effect.gen(function* () {
          const live = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.runAttemptId === resumed.attemptId &&
              event.payload.status === "running",
          );
          yield* Queue.offer(events, providerTurnFor(resumed, "running", yield* DateTime.now));
          yield* Fiber.join(live);
        });
        const activeFollowupId = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
          (run) => run.id === resumed.runId,
        )!.delegatedTaskId;
        assert.isDefined(activeFollowupId);
        if (timing === "live" || timing === "promoted") yield* goLive;
        const messageId = MessageId.make("message:parent-answer");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("parent-answer"),
          threadId: childThreadId,
          senderThreadId: threadId,
          messageId,
          text: "Use the adaptive barrier setting",
          attachments: [],
          dispatchMode:
            timing === "promoted"
              ? { type: "queue_after_active" }
              : { type: "steer_active", targetRunId: resumed.runId },
          createdBy: "agent",
          creationSource: "mcp",
        });
        const followup = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) =>
            task.id !== original.id && (timing !== "promoted" || task.id !== activeFollowupId),
        )!;
        assert.isDefined(followup);
        if (timing === "promoted") {
          const queued = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
            (run) => run.userMessageId === messageId,
          )!;
          assert.equal(queued.status, "queued");
          assert.equal(queued.delegatedTaskId, followup.id);
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-followup"),
            threadId: childThreadId,
            queuedRunId: queued.id,
            targetRunId: resumed.runId,
          });
          const promoted = yield* orchestrator.getThreadProjection(childThreadId);
          assert.equal(promoted.runs.find((run) => run.id === queued.id)?.status, "cancelled");
          assert.equal(
            promoted.messages.find((message) => message.id === messageId)?.runId,
            resumed.runId,
          );
        } else if (timing !== "live") {
          const promoted = yield* watch(
            (event) =>
              event.type === "message.updated" &&
              event.payload.id === messageId &&
              event.payload.runId === resumed.runId,
          );
          yield* goLive;
          yield* Fiber.join(promoted);
        }
        yield* worker.drain();
        assert.deepEqual(steered, [messageId]);
        assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childThreadId, followup.id));
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNull(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === followup.id,
          )!.result,
          "steering into a live run must not publish the cancelled queue holder",
        );
        if (timing === "held-switch") {
          const sink = yield* EventSink.EventSinkV2;
          const child = yield* orchestrator.getThreadProjection(childThreadId);
          const source = child.runs.find((run) => run.id === resumed.runId)!;
          const failedAt = yield* DateTime.now;
          yield* TestClock.adjust("3 minutes");
          const completedAt = yield* DateTime.now;
          const switchedRunId = RunId.make("run:switched-provider");
          const switchedSelection = { ...modelSelection, model: "switched-model" };
          // Replay persisted switch completion after the source's recovery hold expires.
          yield* sink.write({
            commandId: CommandId.make("command:runtime-reconcile:completed-provider-switch"),
            events: [
              {
                id: EventId.make("event:source-usage-limit"),
                type: "run.updated",
                threadId: childThreadId,
                occurredAt: failedAt,
                payload: { ...source, status: "failed", completedAt: failedAt },
              },
              {
                id: EventId.make("event:provider-switched"),
                type: "thread.provider-switched",
                threadId: childThreadId,
                occurredAt: failedAt,
                payload: {
                  ...child.thread,
                  modelSelection: switchedSelection,
                  autoProviderSwitch: {
                    runId: source.id,
                    from: modelSelection,
                    to: switchedSelection,
                    resetAt: DateTime.formatIso(DateTime.add(failedAt, { hours: 1 })),
                    message: "Usage limit; switched provider selection.",
                  },
                },
              },
              {
                id: EventId.make("event:switched-run-completed"),
                type: "run.updated",
                threadId: childThreadId,
                occurredAt: completedAt,
                payload: {
                  ...source,
                  id: switchedRunId,
                  ordinal: 4,
                  userMessageId: usageLimitSwitchMessageId(childThreadId, source.id),
                  rootNodeId: NodeId.make("node:switched-provider"),
                  activeAttemptId: null,
                  modelSelection: switchedSelection,
                  status: "completed",
                  requestedAt: failedAt,
                  startedAt: failedAt,
                  completedAt,
                },
              },
              {
                id: EventId.make("event:switched-provider-result"),
                type: "message.updated",
                threadId: childThreadId,
                occurredAt: completedAt,
                payload: {
                  id: MessageId.make("message:switched-provider-result"),
                  threadId: childThreadId,
                  runId: switchedRunId,
                  nodeId: NodeId.make("node:switched-provider"),
                  role: "assistant",
                  text: "Switched provider finished the checks.",
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: completedAt,
                  updatedAt: completedAt,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
        } else {
          yield* finish(resumed);
        }
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const task = finished.subagents.find((row) => row.id === followup.id)!;
        assert.equal(task.status, "completed");
        if (timing === "held-switch") {
          assert.equal(task.result, "Switched provider finished the checks.");
        }
        assert.isFalse(yield* orchestrator.delegatedTaskResultPending(childThreadId, followup.id));
        assert.isNotNull(task.completedAt);
        assert.isNotNull(task.result);
        if (timing === "promoted") {
          const activeFollowup = finished.subagents.find((row) => row.id === activeFollowupId)!;
          assert.equal(activeFollowup.status, "completed");
          assert.equal(activeFollowup.result, task.result);
          assert.isNotNull(activeFollowup.completedAt);
          assert.equal(activeFollowup.completionDelivery?.state, "claimed");
          assert.equal(
            finished.nodes.find((node) => node.id === activeFollowupId)?.status,
            "completed",
          );
          assert.equal(
            finished.turnItems.find(
              (item) => item.type === "subagent" && item.subagentId === activeFollowupId,
            )?.status,
            "completed",
          );
          assert.isFalse(
            yield* orchestrator.delegatedTaskResultPending(childThreadId, activeFollowupId),
          );
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === childThreadId &&
                transfer.sourcePoint.runId === resumed.runId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(recovered.subagents, finished.subagents);
          assert.deepEqual(recovered.contextTransfers, finished.contextTransfers);
        }
        assert.equal(task.completionDelivery?.state, "claimed");
        assert.equal(finished.nodes.find((node) => node.id === task.id)?.status, "completed");
        assert.equal(
          finished.turnItems.find((item) => item.type === "subagent" && item.subagentId === task.id)
            ?.status,
          "completed",
        );
        assert.deepEqual(
          finished.subagents.find((row) => row.id === original.id),
          published,
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("ack-followup"),
          parentThreadId: threadId,
          taskId: task.id,
          observedByRunId: parentRun.id,
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (row) => row.id === task.id,
          )?.completionDelivery?.state,
          "acknowledged",
        );
      }),
    ),
);
