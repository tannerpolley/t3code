import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as WorkerRetention from "./WorkerRetention.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("keeps a top-level thread out of worker archive and retention", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:owner");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-owner"),
      threadId,
      projectId: ProjectId.make("project:retention"),
      title: "Owner",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const archive = {
      type: "thread.archive" as const,
      commandId: CommandId.make("auto-archive-owner"),
      threadId,
      workerArchiveSequence: 0,
    };
    yield* orchestrator.dispatch(archive);
    assert.isNull((yield* projections.getThread(threadId)).archivedAt);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-owner"),
      threadId,
    });
    yield* TestClock.adjust("15 days");
    const cleanup = {
      type: "thread.delete" as const,
      commandId: CommandId.make("auto-delete-owner"),
      threadId,
      workerDeleteArchivedAt: now,
    };
    yield* orchestrator.dispatch(cleanup);
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
  }).pipe(Effect.provide(layerTest)),
);

const layerRetention = WorkerRetention.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest({}),
      Layer.mock(IssueService.IssueService)({}),
      Layer.mock(PullRequestService.PullRequestService)({}),
    ),
  ),
);

it.effect("previews and archives only finished workers and leaves restored workers active", () =>
  Effect.gen(function* () {
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
                    ...(state === "merged" ? { mergedAt: iso } : {}),
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

    assert.deepEqual(yield* service.archiveBacklog({ kind: "archive", token: preview.token }), {
      kind: "archived",
      archived: 1,
    });
    assert.isNotNull((yield* projections.getThread(done)).archivedAt);
    assert.isNull((yield* projections.getThread(open)).archivedAt);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("restore"),
      threadId: done,
    });
    yield* service.autoArchive(done);
    assert.isNull((yield* projections.getThread(done)).archivedAt);
    assert.deepEqual(yield* service.archiveBacklog({ kind: "preview" }), { kind: "completed" });

    yield* TestClock.adjust("1 second");
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const restored = yield* projections.getThread(done);
    const [link] = restored.pullRequests!;
    const key = { host: "github.com", repository: "owner/project", number: 43 };
    yield* orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make("link-new-work"),
      threadId: done,
      ...key,
      url: "https://github.com/owner/project/pull/43",
      source: "agent",
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request-link.sync",
      commandId: CommandId.make("another-pr-merged"),
      threadId: done,
      ...key,
      snapshot: { ...link!.snapshot!, mergedAt: iso, updatedAt: iso, syncedAt: iso },
      stack: null,
    });
    yield* service.autoArchive(done);
    assert.isNotNull((yield* projections.getThread(done)).archivedAt);
    yield* TestClock.adjust("13 days");
    yield* service.removeExpired();
    assert.isNull((yield* projections.getThread(done)).deletedAt);
    yield* TestClock.adjust("1 day");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(done)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);
