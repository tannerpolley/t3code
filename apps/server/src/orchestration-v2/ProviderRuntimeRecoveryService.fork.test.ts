import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect.each(["startup", "shutdown"] as const)(
  "%s preserves a replayable waiting run while recording its cancelled background work",
  (phase) => {
    const threadId = ThreadId.make("thread_waiting_checkpoint");
    const runId = RunId.make("run_waiting_checkpoint");
    const providerThreadId = ProviderThreadId.make("provider_thread_waiting_checkpoint");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const backgroundItemId = TurnItemId.make("turn_item_waiting_checkpoint");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "idle",
          ownerNodeId: null,
          pendingBackgroundTasks: [
            {
              taskId: String(backgroundItemId),
              kind: "command",
              description: "Finish background task",
            },
            { taskId: "monitor", kind: "monitor", description: "Watch background changes" },
          ],
        },
      ],
      runs: [{ id: runId, status: "waiting", providerInstanceId, providerThreadId }],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: backgroundItemId,
          runId,
          nodeId: null,
          providerThreadId,
          type: "command_execution",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
              } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () =>
              Effect.succeed([
                {
                  request: { type: "checkpoint.capture", runId },
                  status: "running",
                },
              ] as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile(phase);
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.requeuedEffects, 1);

      const command = committedInput;
      assert.isNotNull(command);
      if (command === null) return;

      assert.isFalse(command.events.some((event) => event.type === "run.updated"));
      const recorded = command.events.flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );

      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId, kinds: ["shell", "monitor"] }],
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === backgroundItemId &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreadId &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { status: "queued", managed: false },
  { status: "queued", managed: true },
  { status: "preparing", managed: false },
] as const)("recovers $status work after restart (managed=$managed)", ({ status, managed }) => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, ...(managed ? { linkedIssue: { id: "issue:restart" } } : {}) },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status,
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        ...(status === "preparing"
          ? {
              workspacePreparation: {
                type: "worktree",
                baseRef: "parent-local-commit",
                startFromOrigin: false,
              },
            }
          : {}),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, status === "preparing" ? 1 : 0);
    const command = committedInput;
    if (managed) {
      assert.isNull(command);
      return;
    }
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(
      runEvent?.type === "run.updated" ? runEvent.payload.status : null,
      status === "preparing" ? "cancelled" : "queued",
    );
    assert.isEmpty(command.effects);
    if (status === "preparing") {
      assert.equal(
        attemptEvent?.type === "run-attempt.updated" ? attemptEvent.payload.status : null,
        "cancelled",
      );
      assert.equal(
        nodeEvent?.type === "node.updated" ? nodeEvent.payload.status : null,
        "cancelled",
      );
    } else {
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : null, 1);
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queueHeld : false, true);
      assert.isUndefined(attemptEvent);
      assert.isUndefined(nodeEvent);
    }
  }).pipe(Effect.provide(layer));
});
