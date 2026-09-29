import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { selectTitleRefreshThreads } from "./ThreadTitleRefreshWorker.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const MINUTE_MS = 60_000;
const NOW_MS = Date.parse("2026-09-29T12:00:00.000Z");
const minutesAgo = (minutes: number) => NOW_MS - minutes * MINUTE_MS;
const isoMinutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(minutesAgo(minutes)));
const instanceId = ProviderInstanceId.make("codex");

function thread(name: string, overrides: Partial<OrchestrationV2AppThread> = {}) {
  const id = ThreadId.make(`thread:title-refresh:${name}`);
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:title-refresh"),
    title: name,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-6-luna" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(minutesAgo(600)),
    updatedAt: DateTime.makeUnsafe(minutesAgo(600)),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  } satisfies OrchestrationV2AppThread;
}

const evaluated = (minutes: number) => ({
  titleEvaluation: {
    requestId: CommandId.make(`request:${minutes}`),
    outcome: "unchanged" as const,
    evaluatedAt: isoMinutesAgo(minutes),
  },
});
const regenerating = (minutes: number) => ({
  titleRegeneration: {
    requestId: CommandId.make(`request:in-flight:${minutes}`),
    startedAt: DateTime.makeUnsafe(minutesAgo(minutes)),
  },
});
const select = (
  candidates: ReadonlyArray<{ thread: OrchestrationV2AppThread; latestMessageAt: string | null }>,
  fallbackMinutesAgo = 30,
) =>
  selectTitleRefreshThreads(candidates, {
    nowMs: NOW_MS,
    fallbackEvaluatedAtMs: minutesAgo(fallbackMinutesAgo),
  }).map((selected) => selected.title);

describe("selectTitleRefreshThreads", () => {
  it("picks generated titles with messages newer than an evaluation at least ten minutes old", () => {
    assert.deepEqual(
      select([
        { thread: thread("due", evaluated(20)), latestMessageAt: isoMinutesAgo(5) },
        {
          thread: thread("typed", { ...evaluated(20), titleSource: "user" }),
          latestMessageAt: isoMinutesAgo(5),
        },
        { thread: thread("idle", evaluated(20)), latestMessageAt: isoMinutesAgo(25) },
        { thread: thread("recent", evaluated(5)), latestMessageAt: isoMinutesAgo(1) },
        { thread: thread("empty", evaluated(20)), latestMessageAt: null },
      ]),
      ["due"],
    );
  });

  it("counts only messages after the fallback marker for never-evaluated threads", () => {
    assert.deepEqual(
      select([
        { thread: thread("new since start"), latestMessageAt: isoMinutesAgo(5) },
        { thread: thread("old history"), latestMessageAt: isoMinutesAgo(40) },
      ]),
      ["new since start"],
    );
    // Ten minutes have not passed since the fallback marker.
    assert.deepEqual(
      select([{ thread: thread("new since start"), latestMessageAt: isoMinutesAgo(1) }], 5),
      [],
    );
  });

  it("skips in-flight threads and caps concurrent regenerations, most overdue first", () => {
    const due = [
      { thread: thread("older", evaluated(60)), latestMessageAt: isoMinutesAgo(1) },
      { thread: thread("newer", evaluated(20)), latestMessageAt: isoMinutesAgo(1) },
      { thread: thread("oldest", evaluated(90)), latestMessageAt: isoMinutesAgo(1) },
    ];
    assert.deepEqual(select(due), ["oldest", "older"]);
    const busy = {
      thread: thread("busy", { ...evaluated(90), ...regenerating(1) }),
      latestMessageAt: isoMinutesAgo(1),
    };
    assert.deepEqual(select([...due, busy]), ["oldest"]);
    // A marker older than the interval no longer holds a slot, but its thread stays skipped.
    const stuck = {
      thread: thread("stuck", { ...evaluated(90), ...regenerating(30) }),
      latestMessageAt: isoMinutesAgo(1),
    };
    assert.deepEqual(select([...due, stuck]), ["oldest", "older"]);
  });
});

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for title refresh"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const orchestratorLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-title-refresh" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "reads live top-level threads with their latest message, and a rename beats a refresh",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const create = (name: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${name}`),
          threadId: ThreadId.make(`thread:${name}`),
          projectId: ProjectId.make("project:title-refresh"),
          title: name,
          modelSelection: { instanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      yield* create("top");
      yield* create("quiet");
      yield* create("archived");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId: ThreadId.make("thread:archived"),
      });
      const top = yield* projections.getThread(ThreadId.make("thread:top"));
      const childId = ThreadId.make("thread:child");
      yield* projections.apply({
        id: EventId.make("event:child"),
        type: "thread.created",
        threadId: childId,
        occurredAt: top.createdAt,
        payload: {
          ...top,
          id: childId,
          title: "child",
          lineage: {
            parentThreadId: top.id,
            relationshipToParent: "subagent",
            rootThreadId: top.id,
          },
        },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("message:top"),
        threadId: top.id,
        messageId: MessageId.make("message:top"),
        text: "Fix the reconnect loop",
        attachments: [],
        modelSelection: { instanceId, model: "gpt-5.4" },
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });

      const candidates = yield* projections.getTitleRefreshCandidates();
      assert.deepEqual(
        candidates
          .map(({ thread, latestMessageAt }) => [thread.title, latestMessageAt !== null])
          .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        [
          ["quiet", false],
          ["top", true],
        ],
      );

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:top"),
        threadId: top.id,
        title: "Renamed by hand",
      });
      const refresh = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("server:title-refresh:top"),
          threadId: top.id,
          regenerateTitle: true,
          expectedTitle: "top",
        }),
      );
      assert.equal(refresh._tag, "Failure");
      const renamed = yield* projections.getThread(top.id);
      assert.equal(renamed.titleSource, "user");
      assert.isNotOk(renamed.titleRegeneration);
    }).pipe(Effect.provide(orchestratorLayer)),
);
