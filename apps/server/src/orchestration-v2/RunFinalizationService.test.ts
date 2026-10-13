import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  CheckpointId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "settles checkpoint exhaustion and holds queued work without leaving the thread busy",
  () => {
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "test" };
    const adapter = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("held work must not start a provider"),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    const layerDatabase = SqlitePersistence.layerMemory;
    const capture = vi.fn(
      (input: Parameters<CheckpointService.CheckpointServiceV2["Service"]["capture"]>[0]) =>
        Effect.fail(
          new CheckpointService.CheckpointCaptureError({
            scopeId: input.scope.id,
            cause: "injected checkpoint capture failure",
          }),
        ),
    );
    const layer = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "checkpoint-exhaustion" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        {
          databaseLayer: layerDatabase,
          runEffectWorker: false,
          checkpointService: CheckpointService.CheckpointServiceV2.of({
            capture,
            captureBaseline: () => Effect.void,
            materializeBaselineCheckpoint: () => Effect.die("baseline already seeded"),
            prepareRootRunScope: () => Effect.die("unused prepare"),
            ensureScope: () => Effect.die("unused ensure"),
            restore: () => Effect.die("unused restore"),
            deleteStaleRefs: () => Effect.die("unused delete"),
          }),
        },
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:checkpoint-exhaustion");
      const runId = RunId.make("run:checkpoint-exhaustion");
      const queuedId = RunId.make("run:checkpoint-exhaustion:queued");
      const rootNodeId = NodeId.make("node:checkpoint-exhaustion");
      const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-exhaustion");
      const scopeId = CheckpointScopeId.make("scope:checkpoint-exhaustion");
      const effectId = "effect:checkpoint-exhaustion";
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-checkpoint-exhaustion"),
        threadId,
        projectId: ProjectId.make("project:checkpoint-exhaustion"),
        title: "Checkpoint exhaustion",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:checkpoint-exhaustion"),
        rootNodeId,
        activeAttemptId: RunAttemptId.make("attempt:checkpoint-exhaustion"),
        status: "waiting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* sink.writeWithEffects({
        events: [
          {
            id: EventId.make("seed-waiting-run"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("seed-queued-run"),
            type: "run.updated",
            threadId,
            runId: queuedId,
            occurredAt: now,
            payload: {
              ...run,
              id: queuedId,
              ordinal: 2,
              status: "queued",
              startedAt: null,
              rootNodeId: null,
              activeAttemptId: null,
            },
          },
          {
            id: EventId.make("seed-waiting-node"),
            type: "node.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "waiting",
              countsForRun: true,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: scopeId,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("seed-provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: rootNodeId,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("seed-checkpoint-scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: now,
            payload: {
              id: scopeId,
              threadId,
              runId,
              nodeId: rootNodeId,
              parentScopeId: null,
              providerThreadId,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/repo",
              createdAt: now,
            },
          },
          {
            id: EventId.make("seed-checkpoint-baseline"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: CheckpointId.make("checkpoint:baseline"),
              threadId,
              scopeId,
              runId: null,
              nodeId: rootNodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/t3/test-baseline"),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
        effects: [
          {
            id: effectId,
            commandId: CommandId.make("capture-checkpoint-exhaustion"),
            threadId,
            request: { type: "checkpoint.capture", runId, scopeId },
          },
        ],
      });
      assert.isFalse(yield* projections.canStartQueuedRun(threadId));
      const interrupted = yield* RunFinalization.RunFinalizationService.pipe(
        Effect.flatMap((service) =>
          service.finalize({ threadId, runId, scopeId }, { willRetry: false }),
        ),
        Effect.provide(
          Layer.fresh(RunFinalization.layer).pipe(
            Layer.provide(
              Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
                execute: () => Effect.interrupt,
              }),
            ),
            Layer.provide(IdAllocator.layer),
          ),
        ),
        Effect.exit,
      );
      assert.isTrue(
        Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause),
        Exit.isFailure(interrupted) ? Cause.pretty(interrupted.cause) : "capture did not interrupt",
      );
      assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]?.status, "waiting");
      // Start at the penultimate attempt to verify retry and exhaustion without waiting on backoff.
      yield* sql`UPDATE orchestration_v2_effect_outbox SET attempt_count = 3 WHERE effect_id = ${effectId}`;
      assert.equal(yield* worker.drain(), 1);
      assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]?.status, "waiting");
      assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "pending");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = ${DateTime.formatIso(now)} WHERE effect_id = ${effectId}`;
      const afterSequence = yield* sink.latestSequence();
      assert.equal(yield* worker.drain(), 1);
      assert.equal(capture.mock.calls.length, 2);
      assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "failed");
      const terminal = yield* projections.getThreadProjection(threadId);
      assert.equal(terminal.runs.find((row) => row.id === runId)?.status, "failed");
      assert.equal(terminal.nodes.find((row) => row.id === rootNodeId)?.status, "failed");
      assert.ok(
        terminal.turnItems.some(
          (item) => item.type === "error" && item.failure.code === "checkpoint_capture_failed",
        ),
      );
      // Await the existing terminal-run handler's persisted queue hold, not a timer.
      yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === queuedId &&
            stored.event.payload.queueHeld === true,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const held = yield* projections.getThreadProjection(threadId);
      assert.equal(held.runs.find((row) => row.id === queuedId)?.status, "queued");
      assert.isTrue(held.runs.find((row) => row.id === queuedId)?.queueHeld);
      const shell = yield* projections.getThreadShell(threadId);
      assert.ok(shell);
      assert.isNull(shell.activeRunId);
      assert.notEqual(shell.status, "active");
      assert.isFalse(yield* projections.canStartQueuedRun(threadId));
      // The remaining barrier is the deliberate queue hold; releasing it restores eligibility.
      const queued = held.runs.find((row) => row.id === queuedId)!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("release-checkpoint-queue-hold"),
            type: "run.updated",
            threadId,
            runId: queuedId,
            occurredAt: now,
            payload: { ...queued, queueHeld: false },
          },
        ],
      });
      assert.isTrue(yield* projections.canStartQueuedRun(threadId));
    }).pipe(Effect.provide(layer));
  },
);
