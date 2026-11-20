import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IssueOperationError,
  IssueTrackerKind,
  MessageId,
  ProviderThreadId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as GitManager from "../git/GitManager.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import WorkerArchiveBacklog from "../persistence/ForkMigrations/031_WorkerArchiveBacklog.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as WorkerRetention from "./WorkerRetention.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerRetention = WorkerRetention.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest({}),
      Layer.mock(IssueService.IssueService)({
        detail: () =>
          Effect.fail(new IssueOperationError({ operation: "detail", detail: "Offline" })),
      }),
      Layer.mock(GitManager.GitManager)({}),
      Layer.mock(PullRequestService.PullRequestService)({
        summary: (reference) =>
          Effect.succeed({
            ...reference,
            provider: SourceControlProviderKind.make("github"),
            title: "Pull request",
            url: "https://github.com/owner/project/pull/42",
            state: reference.number === 42 ? "open" : "merged",
            headBranch: "feature",
            baseBranch: "main",
            updatedAt: "1970-01-01T00:00:00.000Z",
            mergedAt: "1970-01-01T00:00:00.000Z",
          }),
      }),
    ),
  ),
);

const makeFixture = Effect.fn("WorkerRetention.test.fixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* WorkerRetention.WorkerRetention;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const [backlog] = yield* sql<{ cutoff: string }>`SELECT cutoff FROM worker_archive_backlog`;
  yield* TestClock.adjust("1 second");
  const cutoff = DateTime.makeUnsafe(backlog!.cutoff);
  const createdAt = DateTime.subtract(cutoff, { days: 1 });
  const parent = ThreadId.make("parent");
  const seed = Effect.fn("WorkerRetention.test.seed")(function* (
    key: string,
    state: "open" | "merged",
    overrides: Partial<OrchestrationV2AppThread> = {},
    completedAt = createdAt,
  ) {
    const id = ThreadId.make(key);
    const iso = DateTime.formatIso(createdAt);
    yield* sink.write({
      events: [
        {
          type: "thread.created",
          id: EventId.make(`created:${id}`),
          threadId: id,
          occurredAt: createdAt,
          payload: {
            id,
            projectId: ProjectId.make("project:worker"),
            title: key,
            createdBy: "agent",
            creationSource: "mcp",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              rootThreadId: parent,
              parentThreadId: parent,
              relationshipToParent: "subagent",
            },
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
            archivedAt: null,
            deletedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            pullRequests: [
              {
                host: "github.com",
                repository: "owner/project",
                number: 42,
                url: "https://github.com/owner/project/pull/42",
                source: "agent",
                linkedAt: iso,
                snapshot: {
                  state,
                  title: "Pull request",
                  headBranch: "feature",
                  baseBranch: "main",
                  isDraft: false,
                  syncedAt: iso,
                  updatedAt: iso,
                  ...(state === "merged" ? { mergedAt: DateTime.formatIso(completedAt) } : {}),
                },
                stack: null,
              },
            ],
            ...overrides,
          },
        },
      ],
    });
    return id;
  });

  return { sql, service, orchestrator, projections, sink, cutoff, createdAt, parent, seed };
});

it.effect("keeps a top-level thread with completed work out of worker archive", () =>
  Effect.gen(function* () {
    const { sql, orchestrator, projections, seed, parent } = yield* makeFixture();
    const threadId = yield* seed("owner", "merged", {
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    const [event] = yield* sql<{ sequence: number }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${threadId}
    `;
    assert.isAbove(event!.sequence, 0);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("auto-archive-owner"),
      threadId,
      workerArchiveSequence: event!.sequence,
    });
    assert.isNull((yield* projections.getThread(threadId)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("previews and archives only finished workers and leaves restored workers active", () =>
  Effect.gen(function* () {
    const { sql, service, orchestrator, projections, createdAt, seed } = yield* makeFixture();
    const done = yield* seed("done", "merged");
    const open = yield* seed("open", "open");
    const queued = yield* seed("queued", "merged");
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('queued-run', ${queued}, 1, 'codex', 'queued', ${DateTime.formatIso(createdAt)}, '{}')`;
    yield* seed("owner-child", "merged", { createdBy: "user" });
    yield* seed("orchestrator", "merged", { role: "orchestrator" });
    yield* service.autoArchive(done);
    assert.isNull((yield* projections.getThread(done)).archivedAt);
    const preview = yield* service.archiveBacklog({ kind: "preview" });
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") return;
    assert.deepEqual(
      preview.workers.map(({ id }) => id),
      [done],
    );
    assert.isNull((yield* projections.getThread(done)).archivedAt);

    const result = yield* service.archiveBacklog({ kind: "archive", token: preview.token });
    assert.equal(result.kind === "archived" ? result.archived : -1, 1);
    assert.isNotNull((yield* projections.getThread(done)).archivedAt);
    assert.isNull((yield* projections.getThread(open)).archivedAt);

    yield* TestClock.adjust("1 second");
    const freshAt = yield* DateTime.now;
    const fresh = yield* seed("fresh", "merged", { createdAt: freshAt, archivedAt: freshAt });
    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("restore"),
      threadId: fresh,
    });
    yield* service.autoArchive(fresh);
    assert.isNull((yield* projections.getThread(fresh)).archivedAt);
    assert.deepEqual(yield* service.archiveBacklog({ kind: "preview" }), { kind: "completed" });

    yield* TestClock.adjust("1 second");
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const restored = yield* projections.getThread(fresh);
    const [link] = restored.pullRequests!;
    const key = { host: "github.com", repository: "owner/project", number: 43 };
    yield* orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make("link-new-work"),
      threadId: fresh,
      ...key,
      url: "https://github.com/owner/project/pull/43",
      source: "agent",
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request-link.sync",
      commandId: CommandId.make("another-pr-merged"),
      threadId: fresh,
      ...key,
      snapshot: { ...link!.snapshot!, mergedAt: iso, updatedAt: iso, syncedAt: iso },
      stack: null,
    });
    yield* service.autoArchive(fresh);
    assert.isNotNull((yield* projections.getThread(fresh)).archivedAt);
    yield* TestClock.adjust("13 days");
    yield* service.removeExpired();
    assert.isNull((yield* projections.getThread(fresh)).deletedAt);
    yield* TestClock.adjust("1 day");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(fresh)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps expired unfinished workers during the sweep and direct delete planning", () =>
  Effect.gen(function* () {
    const { service, orchestrator, projections, createdAt, seed, sql } = yield* makeFixture();
    const sweep = yield* seed("open-sweep", "open", { archivedAt: createdAt });
    const locked = yield* seed("open-locked", "open", { archivedAt: createdAt });
    yield* TestClock.adjust("15 days");
    const [event] = yield* sql<{ sequence: number }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${locked}
    `;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-unfinished-worker"),
      threadId: locked,
      workerDeleteArchivedAt: createdAt,
      workerArchiveSequence: event!.sequence,
    });
    yield* service.removeExpired();
    assert.deepEqual(
      [
        (yield* projections.getThread(locked)).deletedAt === null,
        (yield* projections.getThread(sweep)).deletedAt === null,
      ],
      [true, true],
    );
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps pinned workers in both active and archive views", () =>
  Effect.gen(function* () {
    const { service, projections, createdAt, seed } = yield* makeFixture();
    yield* seed("pinned-active", "merged", { pinnedAt: createdAt });
    const archived = yield* seed("pinned-archived", "merged", {
      pinnedAt: createdAt,
      archivedAt: createdAt,
    });
    const preview = yield* service.archiveBacklog({ kind: "preview" });
    yield* TestClock.adjust("15 days");
    yield* service.removeExpired();
    assert.deepEqual(
      [
        preview.kind === "preview" ? preview.workers.length : -1,
        (yield* projections.getThread(archived)).deletedAt === null,
      ],
      [0, true],
    );
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps a worker with a background command in its parent's provider session", () =>
  Effect.gen(function* () {
    const { service, sink, createdAt, parent, seed } = yield* makeFixture();
    const worker = yield* seed("background", "merged");
    yield* seed("parent", "open", {
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    yield* sink.write({
      events: [
        {
          type: "provider-thread.updated",
          id: EventId.make("parent-background"),
          threadId: parent,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make("provider-thread:parent"),
            appThreadId: parent,
            ownerNodeId: null,
            driver: ProviderDriverKind.make("claude"),
            providerInstanceId: instanceId,
            providerSessionId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
            pendingBackgroundTasks: [
              { taskId: "parent-command", kind: "command", ownerThreadId: worker },
            ],
          },
        },
      ],
    });
    const preview = yield* service.archiveBacklog({ kind: "preview" });
    assert.deepEqual(preview.kind === "preview" ? preview.workers : null, []);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect(
  "keeps an old worker for confirmation and rejects obsolete completion for a new worker",
  () =>
    Effect.gen(function* () {
      const { service, sink, projections, seed } = yield* makeFixture();
      const now = yield* DateTime.now;
      const oldWorker = yield* seed("older-worker", "merged", {}, now);
      const freshWorker = yield* seed(
        "newer-worker",
        "merged",
        { createdAt: now, updatedAt: now },
        now,
      );
      yield* TestClock.adjust("1 second");
      const later = yield* DateTime.now;
      for (const [threadId, requestedAt] of [
        [oldWorker, now],
        [freshWorker, later],
      ] as const) {
        yield* sink.write({
          events: [
            {
              type: "run.created",
              id: EventId.make(`created:run:${threadId}`),
              threadId,
              occurredAt: requestedAt,
              payload: {
                id: RunId.make(`run:${threadId}`),
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:${threadId}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt,
                startedAt: requestedAt,
                completedAt: requestedAt,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        yield* service.autoArchive(threadId);
      }
      assert.deepEqual(
        [
          (yield* projections.getThread(oldWorker)).archivedAt === null,
          (yield* projections.getThread(freshWorker)).archivedAt === null,
        ],
        [true, true],
      );
    }).pipe(Effect.provide(layerRetention)),
);

it.effect("backfills the protection timestamp for restores before the upgrade", () =>
  Effect.gen(function* () {
    const { service, sql, sink, projections, createdAt, seed } = yield* makeFixture();
    const worker = yield* seed("previously-restored", "merged");
    const restoredAt = DateTime.add(createdAt, { hours: 1 });
    const thread = yield* projections.getThread(worker);
    yield* sink.write({
      events: [
        {
          type: "thread.unarchived",
          id: EventId.make("historical-restore"),
          threadId: worker,
          occurredAt: restoredAt,
          payload: { ...thread, updatedAt: restoredAt },
        },
      ],
    });
    yield* sql`DROP TABLE IF EXISTS worker_archive_prior_restores`;
    yield* sql`DROP TABLE worker_archive_backlog`;
    yield* WorkerArchiveBacklog;
    const preview = yield* service.archiveBacklog({ kind: "preview" });
    assert.deepEqual(preview.kind === "preview" ? preview.workers : null, []);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect(
  "includes discovered pull requests and leaves unresolved issue lookups for another preview",
  () =>
    Effect.gen(function* () {
      const { service, seed } = yield* makeFixture();
      const branchWorker = yield* seed("branch", "open", {
        pullRequests: [],
        branchPullRequest: {
          projectId: ProjectId.make("project:worker"),
          repository: "owner/project",
          number: 43,
          url: "https://github.com/owner/project/pull/43",
        },
      });
      yield* seed("unknown", "open", {
        pullRequests: [],
        issues: [
          {
            projectId: ProjectId.make("project:worker"),
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "owner/project",
            key: "42",
            displayKey: "#42",
            title: "Issue",
            url: "https://github.com/owner/project/issues/42",
            source: "agent",
            linkedAt: "1969-12-31T00:00:00.000Z",
          },
        ],
      });
      // Keep one known eligible worker in the baseline so its confirmation reaches the completion write.
      const known = yield* seed("known", "merged");
      const preview = yield* service.archiveBacklog({ kind: "preview" });
      if (preview.kind !== "preview") return assert.fail("Expected a preview");
      yield* service.archiveBacklog({ kind: "archive", token: preview.token });
      const retry = yield* service.archiveBacklog({ kind: "preview" });
      assert.deepEqual(
        [preview.workers.map(({ id }) => id), preview.unknown, retry.kind],
        [[branchWorker, known], 1, "preview"],
      );
    }).pipe(Effect.provide(layerRetention)),
);
