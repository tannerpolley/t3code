import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  NodeId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeSweep } from "./IdleSessionReaper.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { threadIdleSinceMs } from "./ThreadIdleness.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const NOW_MS = Date.parse("2026-09-01T12:00:00.000Z");
const MINUTE_MS = 60_000;
const minutesAgo = (minutes: number) => DateTime.makeUnsafe(NOW_MS - minutes * MINUTE_MS);

type Run = Pick<OrchestrationV2Run, "status" | "requestedAt" | "startedAt" | "completedAt">;
type Request = Pick<OrchestrationV2RuntimeRequest, "status" | "createdAt" | "resolvedAt">;
type Subagent = Pick<OrchestrationV2Subagent, "status" | "updatedAt">;

const finishedRun = (completedMinutesAgo: number): Run => ({
  status: "completed",
  requestedAt: minutesAgo(completedMinutesAgo + 5),
  startedAt: minutesAgo(completedMinutesAgo + 5),
  completedAt: minutesAgo(completedMinutesAgo),
});
const liveRun = (status: Run["status"]): Run => ({
  status,
  requestedAt: minutesAgo(240),
  startedAt: status === "queued" ? null : minutesAgo(240),
  completedAt: null,
});

describe("threadIdleSinceMs", () => {
  const thread = { createdAt: minutesAgo(600) };

  it("returns the latest run, request, or subagent activity", () => {
    assert.equal(
      threadIdleSinceMs({
        thread,
        runs: [finishedRun(90), finishedRun(50)],
        runtimeRequests: [{ status: "resolved", createdAt: minutesAgo(80), resolvedAt: null }],
        subagents: [{ status: "completed", updatedAt: minutesAgo(40) }],
      }),
      NOW_MS - 40 * MINUTE_MS,
    );
    assert.equal(
      threadIdleSinceMs({ thread, runs: [], runtimeRequests: [], subagents: [] }),
      NOW_MS - 600 * MINUTE_MS,
    );
  });

  it("holds any thread that is working or waiting on the user", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
      assert.isNull(
        threadIdleSinceMs({ thread, runs: [liveRun(status)], runtimeRequests: [], subagents: [] }),
        status,
      );
    }
    assert.isNull(
      threadIdleSinceMs({
        thread,
        runs: [finishedRun(120)],
        runtimeRequests: [{ status: "pending", createdAt: minutesAgo(119), resolvedAt: null }],
        subagents: [],
      }),
    );
    for (const status of ["pending", "running", "waiting"] as const) {
      assert.isNull(
        threadIdleSinceMs({
          thread,
          runs: [finishedRun(120)],
          runtimeRequests: [],
          subagents: [{ status, updatedAt: minutesAgo(119) }],
        }),
        status,
      );
    }
  });
});

interface ThreadFixture {
  readonly sessions?: ReadonlyArray<OrchestrationV2ProviderSession["status"]>;
  readonly runs?: ReadonlyArray<Run>;
  readonly runtimeRequests?: ReadonlyArray<Request>;
  readonly subagents?: ReadonlyArray<Subagent>;
  /** Native subagents: status and minutes since they last did anything. */
  readonly nativeSubagents?: ReadonlyArray<readonly [Subagent["status"], number]>;
  readonly pendingBackgroundTasks?: number;
}

const nativeThreadId = (threadId: string, index: number) =>
  ProviderThreadId.make(`provider-thread:${threadId}:subagent-${index}`);

type DetachCommand = Extract<OrchestrationV2Command, { readonly type: "provider-session.detach" }>;

const makeHarness = Effect.fn("makeIdleSessionReaperHarness")(function* (
  fixtures: Record<string, ThreadFixture>,
  settings: ServerSettings,
) {
  const settingsRef = yield* Ref.make(settings);
  const commands = yield* Ref.make<ReadonlyArray<DetachCommand>>([]);
  const threadScans = yield* Ref.make(0);
  const unloaded = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
  const fixture = (threadId: ThreadId) => fixtures[threadId]!;
  const sessionId = (threadId: ThreadId, index: number) =>
    ProviderSessionId.make(`session:${threadId}:${index}`);
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStoreV2)({
      getRecoveryThreadIds: () =>
        Ref.update(threadScans, (count) => count + 1).pipe(
          Effect.as(Object.keys(fixtures).map((id) => ThreadId.make(id))),
        ),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          thread: { id: threadId, createdAt: minutesAgo(600) },
          providerSessions: (fixture(threadId).sessions ?? ["ready"]).map((status, index) => ({
            id: sessionId(threadId, index),
            status,
          })),
          runs: fixture(threadId).runs ?? [],
          runtimeRequests: fixture(threadId).runtimeRequests ?? [],
          subagents: [
            ...(fixture(threadId).subagents ?? []),
            ...(fixture(threadId).nativeSubagents ?? []).map(([status, idleMinutes], index) => ({
              status,
              updatedAt: minutesAgo(idleMinutes),
              completedAt:
                status === "running" || status === "pending" ? null : minutesAgo(idleMinutes),
              providerThreadId: nativeThreadId(threadId, index),
            })),
          ],
          providerThreads: (fixture(threadId).nativeSubagents ?? []).map((_, index) => ({
            id: nativeThreadId(threadId, index),
          })),
        })) as unknown as ProjectionStoreV2["Service"]["getThreadRecords"],
      getThreadShell: (threadId) =>
        Effect.succeed({
          pendingBackgroundTasks: Array.from(
            { length: fixture(threadId).pendingBackgroundTasks ?? 0 },
            (_, index) => ({ taskId: `task-${index}` }),
          ),
        } as never),
    }),
    Layer.mock(ThreadManagementService)({
      dispatch: (command) =>
        command.type === "provider-session.detach"
          ? Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
    }),
    Layer.mock(ServerSettingsService)({ getSettings: Ref.get(settingsRef) }),
    Layer.mock(ProviderSessionManagerV2)({
      unloadProviderThread: (providerThread: OrchestrationV2ProviderThread) =>
        Ref.update(unloaded, (ids) => [...ids, providerThread.id]).pipe(Effect.as(true)),
    }),
  );
  const sweep = yield* makeSweep.pipe(Effect.provide(layer));
  return { sweep, settingsRef, commands, threadScans, unloaded, sessionId };
});

describe("IdleSessionReaper sweep", () => {
  it.effect(
    "disconnects only idle threads, including finished children, through the manual detach",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const harness = yield* makeHarness(
          {
            idle: { sessions: ["ready", "stopped"], runs: [finishedRun(45)] },
            "finished-child": { runs: [finishedRun(40)] },
            "parent-of-finished-child": {
              runs: [finishedRun(50)],
              subagents: [{ status: "completed", updatedAt: minutesAgo(35) }],
            },
            working: { sessions: ["running"], runs: [liveRun("running")] },
            queued: { runs: [finishedRun(120), liveRun("queued")] },
            "pending-approval": {
              runs: [finishedRun(120)],
              runtimeRequests: [
                { status: "pending", createdAt: minutesAgo(119), resolvedAt: null },
              ],
            },
            "parent-of-running-child": {
              runs: [finishedRun(120)],
              subagents: [{ status: "running", updatedAt: minutesAgo(110) }],
            },
            "recently-active": { runs: [finishedRun(29)] },
            "background-task": { runs: [finishedRun(120)], pendingBackgroundTasks: 1 },
            "already-stopped": { sessions: ["stopped"], runs: [finishedRun(120)] },
          },
          { ...DEFAULT_SERVER_SETTINGS, idleAgentSessionMinutes: 30 },
        );

        yield* harness.sweep();

        const expected = [
          ["idle", 0, 45],
          ["idle", 1, 45],
          ["finished-child", 0, 40],
          ["parent-of-finished-child", 0, 35],
        ] as const;
        assert.deepEqual(
          yield* Ref.get(harness.commands),
          expected.map(([id, index, idleMinutes]) => {
            const threadId = ThreadId.make(id);
            const providerSessionId = harness.sessionId(threadId, index);
            return {
              type: "provider-session.detach" as const,
              commandId: CommandId.make(
                `server:idle-disconnect:${threadId}:${NOW_MS}:${providerSessionId}`,
              ),
              threadId,
              providerSessionId,
              reason: "idle-timeout",
              ifIdleSince: minutesAgo(idleMinutes),
            };
          }),
        );
      }),
  );

  it.effect("unloads a settled idle native subagent once while its parent stays connected", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness(
        {
          "parent-in-use": {
            runs: [finishedRun(5)],
            nativeSubagents: [
              ["completed", 40],
              ["failed", 31],
              ["completed", 10],
              ["idle", 90],
            ],
          },
          "parent-with-running-subagent": {
            runs: [finishedRun(5)],
            nativeSubagents: [
              ["completed", 90],
              ["running", 90],
            ],
          },
          "parent-with-pending-subagent": {
            runs: [finishedRun(5)],
            nativeSubagents: [
              ["cancelled", 90],
              ["pending", 90],
            ],
          },
          "working-parent": {
            runs: [liveRun("running")],
            nativeSubagents: [["completed", 90]],
          },
        },
        { ...DEFAULT_SERVER_SETTINGS, idleAgentSessionMinutes: 30 },
      );

      yield* harness.sweep();
      yield* harness.sweep();

      assert.deepEqual(yield* Ref.get(harness.unloaded), [
        nativeThreadId("parent-in-use", 0),
        nativeThreadId("parent-in-use", 1),
      ]);
      assert.deepEqual(yield* Ref.get(harness.commands), []);
    }),
  );

  it.effect("stays off at 0 and follows a live setting change", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* makeHarness(
        { idle: { runs: [finishedRun(20)] } },
        DEFAULT_SERVER_SETTINGS,
      );
      assert.equal(DEFAULT_SERVER_SETTINGS.idleAgentSessionMinutes, 0);

      yield* harness.sweep();
      assert.equal(yield* Ref.get(harness.threadScans), 0);

      yield* Ref.update(harness.settingsRef, (current) => ({
        ...current,
        idleAgentSessionMinutes: 15,
      }));
      yield* harness.sweep();
      assert.deepEqual(
        (yield* Ref.get(harness.commands)).map((command) => command.threadId),
        [ThreadId.make("idle")],
      );
    }),
  );
});

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for detach decisions"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const orchestratorLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "idle-session-detach" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("an idle detach loses to activity recorded after the sweep read the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const threadId = ThreadId.make("thread:idle-detach");
    const sessionId = ProviderSessionId.make("session:idle-detach");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-idle-detach"),
      threadId,
      projectId: ProjectId.make("project:idle-detach"),
      title: "Idle",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const createdAt = (yield* projections.getThread(threadId)).createdAt;
    yield* projections.apply({
      id: EventId.make("attach-idle-detach"),
      type: "provider-session.attached",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "gpt-5.4",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      },
    });
    const detach = (commandId: string, ifIdleSince: DateTime.Utc) =>
      Effect.exit(
        orchestrator.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make(commandId),
          threadId,
          providerSessionId: sessionId,
          reason: "idle-timeout",
          ifIdleSince,
        }),
      );

    // The thread was created after the time the sweep believed it went idle.
    const stale = yield* detach("detach-stale", DateTime.subtract(createdAt, { minutes: 1 }));
    assert.equal(stale._tag, "Failure");

    // A question now waits on the user.
    const requestId = RuntimeRequestId.make("request:idle-detach");
    yield* projections.apply({
      id: EventId.make("request-idle-detach"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: requestId,
        nodeId: NodeId.make("node:idle-detach"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt,
        resolvedAt: null,
      },
    });
    const blocked = yield* detach("detach-blocked", createdAt);
    assert.equal(blocked._tag, "Failure");
    assert.equal((yield* projections.getThreadProjection(threadId)).providerSessions.length, 1);

    yield* projections.apply({
      id: EventId.make("request-idle-detach-resolved"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: requestId,
        nodeId: NodeId.make("node:idle-detach"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt,
        resolvedAt: createdAt,
      },
    });
    const accepted = yield* detach("detach-idle", createdAt);
    assert.equal(accepted._tag, "Success");
    assert.deepEqual((yield* projections.getThreadProjection(threadId)).providerSessions, []);
  }).pipe(Effect.provide(orchestratorLayer)),
);
