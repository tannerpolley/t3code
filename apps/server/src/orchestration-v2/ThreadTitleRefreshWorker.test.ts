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
  type ThreadLinkedIssue,
  issueThreadTitle,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
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
  projectionMaintenanceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        projectionLayer.pipe(Layer.provide(database)),
        eventStoreLayer.pipe(Layer.provide(database)),
      ),
    ),
  ),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-title-refresh" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const everyCandidate = {
  evaluatedBefore: "2100-01-01T00:00:00.000Z",
  fallbackEvaluatedAt: "1960-01-01T00:00:00.000Z",
};

const createThread = (name: string, linkedIssue?: ThreadLinkedIssue) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId: ProjectId.make("project:title-refresh"),
      title: name,
      ...(linkedIssue === undefined ? {} : { linkedIssue }),
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const sendMessage = (threadId: ThreadId, name: string, titleSeed?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`message:${name}`),
      threadId,
      messageId: MessageId.make(`message:${name}`),
      text: "Fix the reconnect loop",
      attachments: [],
      modelSelection: { instanceId, model: "gpt-5.4" },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
      ...(titleSeed === undefined ? {} : { titleSeed }),
    });
  });

const metadata = (
  threadId: ThreadId,
  commandId: string,
  update: {
    readonly title?: string;
    readonly regenerateTitle?: boolean;
    readonly titleRefreshGuard?: { title: string; evaluationRequestId: CommandId | null };
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    return yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(commandId),
        threadId,
        ...update,
      }),
    );
  });

it.effect("a title typed before the first message is not replaced by the first-message title", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const threadId = yield* createThread("typed-first");
    yield* metadata(threadId, "rename:typed-first", { title: "Typed before sending" });
    yield* sendMessage(threadId, "typed-first", "Fix the reconnect loop");
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.title, "Typed before sending");
    assert.isNotOk(thread.titleRegeneration);
  }).pipe(Effect.provide(orchestratorLayer)),
);

it.effect("a client rename stays the user's after the projection is rebuilt from events", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenanceV2;
    const threadId = yield* createThread("rebuilt");
    yield* metadata(threadId, "rename:rebuilt", { title: "Typed by hand" });
    // Ownership has no other record: it survives only if the rename event carries it.
    assert.isTrue((yield* maintenance.rebuild).valid);
    const rebuilt = yield* projections.getThread(threadId);
    assert.equal(rebuilt.title, "Typed by hand");
    assert.equal(rebuilt.titleSource, "user");
  }).pipe(Effect.provide(orchestratorLayer)),
);

it.effect("an agent's rename stays eligible for automatic refresh", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const threadId = yield* createThread("agent-renamed");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename:agent-renamed"),
      threadId,
      title: "Agent title",
      renamedBy: "agent",
    });
    assert.equal((yield* projections.getThread(threadId)).titleSource, "generated");
  }).pipe(Effect.provide(orchestratorLayer)),
);

it.effect("an automatic refresh cannot take over a manual Regenerate or a newer evaluation", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const threadId = yield* createThread("manual-first");
    const manual = CommandId.make("manual-regenerate");
    yield* metadata(threadId, manual, { regenerateTitle: true });
    const automatic = (commandId: string, evaluationRequestId: CommandId | null) =>
      metadata(threadId, commandId, {
        regenerateTitle: true,
        titleRefreshGuard: { title: "manual-first", evaluationRequestId },
      });

    assert.equal((yield* automatic("automatic:pending", null))._tag, "Failure");
    assert.equal((yield* projections.getThread(threadId)).titleRegeneration?.requestId, manual);

    yield* orchestrator.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: CommandId.make("manual-regenerate:title-complete"),
      threadId,
      requestId: manual,
    });
    // The sweep read the thread before the manual evaluation landed.
    assert.equal((yield* automatic("automatic:stale", null))._tag, "Failure");
    assert.equal((yield* automatic("automatic:current", manual))._tag, "Success");
  }).pipe(Effect.provide(orchestratorLayer)),
);

it.effect("candidates skip typed and recently evaluated threads before reading messages", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const due = yield* createThread("due");
    yield* sendMessage(due, "due");
    const typed = yield* createThread("typed");
    yield* metadata(typed, "rename:typed", { title: "Typed" });
    yield* sendMessage(typed, "typed");
    const recent = yield* createThread("recent");
    yield* metadata(recent, "regenerate:recent", { regenerateTitle: true });
    yield* orchestrator.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: CommandId.make("regenerate:recent:title-complete"),
      threadId: recent,
      requestId: CommandId.make("regenerate:recent"),
    });
    yield* sendMessage(recent, "recent");
    const busy = yield* createThread("busy");
    yield* metadata(busy, "regenerate:busy", { regenerateTitle: true });
    yield* sendMessage(busy, "busy");

    // Evaluations from the test clock's epoch are newer than this cutoff; the fallback is older.
    const candidates = yield* projections.getTitleRefreshCandidates({
      evaluatedBefore: "1969-12-31T23:59:59.000Z",
      fallbackEvaluatedAt: "1960-01-01T00:00:00.000Z",
    });
    assert.deepEqual(
      candidates
        .map(({ thread, latestMessageAt }) => [thread.id, latestMessageAt !== null])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
      [
        [busy, false],
        [due, true],
      ],
    );

    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT MAX(updated_at) FROM orchestration_v2_projection_messages
      WHERE thread_id = ${due} AND role = 'assistant'
    `;
    assert.include(
      plan.map((row) => row.detail).join("\n"),
      "orchestration_v2_projection_messages_latest_assistant_idx",
    );
  }).pipe(Effect.provide(orchestratorLayer)),
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

      const candidates = yield* projections.getTitleRefreshCandidates(everyCandidate);
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
          titleRefreshGuard: { title: "top", evaluationRequestId: null },
        }),
      );
      assert.equal(refresh._tag, "Failure");
      const renamed = yield* projections.getThread(top.id);
      assert.equal(renamed.titleSource, "user");
      assert.isNotOk(renamed.titleRegeneration);

      yield* create("same-title");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:same-title"),
        threadId: ThreadId.make("thread:same-title"),
        title: "same-title",
      });
      const sameTitleRefresh = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("server:title-refresh:same-title"),
          threadId: ThreadId.make("thread:same-title"),
          regenerateTitle: true,
          titleRefreshGuard: { title: "same-title", evaluationRequestId: null },
        }),
      );
      assert.equal(sameTitleRefresh._tag, "Failure");
      const sameTitle = yield* projections.getThread(ThreadId.make("thread:same-title"));
      assert.equal(sameTitle.titleSource, "user");
      assert.isNotOk(sameTitle.titleRegeneration);
    }).pipe(Effect.provide(orchestratorLayer)),
);

it.effect(
  "issue titles bypass initial and periodic generation, reject late results, and survive replay",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStoreV2;
      const orchestrator = yield* OrchestratorV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const linkedIssue = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        repositoryId: "repository:8",
        id: "issue:8",
        nodeId: "node:8",
        number: 8,
        url: "https://github.com/tannerpolley/t3code/issues/8",
        title: "  Keep   the issue\nnumber  ",
      } satisfies ThreadLinkedIssue;
      assert.equal(issueThreadTitle(linkedIssue), "#8 Keep the issue number");
      const threadId = yield* createThread("issue-title", linkedIssue);
      yield* sendMessage(threadId, "issue-title", "Generated first-message title");
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "#8 Keep the issue number");
      assert.isNotOk(thread.titleRegeneration);
      assert.deepEqual(
        selectTitleRefreshThreads([{ thread, latestMessageAt: "2100-01-01T00:00:00Z" }], {
          nowMs: NOW_MS,
          fallbackEvaluatedAtMs: minutesAgo(30),
        }),
        [],
      );
      assert.equal(
        (yield* metadata(threadId, "issue-rename", { title: "Lose the number" }))._tag,
        "Failure",
      );
      assert.equal(
        (yield* metadata(threadId, "issue-refresh", { regenerateTitle: true }))._tag,
        "Failure",
      );
      const late = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("issue-late-title"),
          threadId,
          requestId: CommandId.make("message:issue-title"),
          title: "Stale result",
        }),
      );
      assert.equal(late._tag, "Failure");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* projections.getThread(threadId)).title, "#8 Keep the issue number");
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.linkedIssue, linkedIssue);
    }).pipe(Effect.provide(orchestratorLayer)),
);
