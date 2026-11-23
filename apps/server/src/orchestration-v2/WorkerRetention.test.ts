import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IssueOperationError,
  IssueTrackerKind,
  MessageId,
  NodeId,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as GitManager from "../git/GitManager.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import WorkerArchiveBacklog from "../persistence/ForkMigrations/031_WorkerArchiveBacklog.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
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
const projectId = ProjectId.make("project:worker");
const workspaceRoot = "/workspace/project";
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
  Layer.mock(ProjectStore.ProjectStoreV2)({
    getShell: () =>
      Effect.succeedSome({
        id: projectId,
        title: "Project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "1969-12-31T00:00:00.000Z",
        updatedAt: "1969-12-31T00:00:00.000Z",
      }),
  }),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerIdentity = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
  resolve: () =>
    Effect.succeed({
      canonicalKey: "github.com/owner/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/owner/project.git",
      },
      provider: SourceControlProviderKind.make("github"),
      owner: "owner",
      name: "project",
    }),
});

const layerRetentionBase = WorkerRetention.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest({}),
      Layer.mock(IssueService.IssueService)({
        detail: (input) => {
          if (input.key === "42") {
            return Effect.fail(new IssueOperationError({ operation: "detail", detail: "Offline" }));
          }
          const closed = input.key === "43";
          const time = "1970-01-01T00:00:00.000Z";
          return Effect.succeed({
            ...input,
            host: "github.com",
            displayKey: `#${input.key}`,
            title: "Issue",
            url: `https://github.com/${input.scope}/issues/${input.key}`,
            author: null,
            state: closed
              ? { category: "closed", name: "Closed" }
              : { category: "open", name: "Open" },
            createdAt: time,
            updatedAt: time,
            closedAt: closed ? time : null,
            assignees: [],
            labels: [],
            commentCount: 0,
            projectTitle: "Project",
            writable: false,
            capabilities: {
              create: false,
              edit: false,
              comment: false,
              labels: false,
              assignees: false,
              reactions: false,
              templates: false,
              linkedPullRequests: false,
              events: false,
              search: false,
            },
            viewerPermissions: {
              setState: false,
              comment: false,
              edit: false,
              labels: false,
              assignees: false,
            },
            states: [],
            viewer: null,
            body: "",
            comments: [],
            commentsCursor: null,
            events: [],
            linkedPullRequests: [],
          });
        },
      }),
      FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      Path.layer,
      Layer.mock(GitManager.GitManager)({
        branchPullRequest: ({ cwd, branch }) =>
          Effect.succeed(
            cwd !== workspaceRoot
              ? null
              : {
                  number: 48,
                  title: "Merged pull request",
                  url: `https://github.com/owner/${branch === "foreign" ? "another" : "project"}/pull/48`,
                  repositoryKey: `github.com/owner/${branch === "foreign" ? "another" : "project"}`,
                  state: "merged",
                  headRef: branch,
                  baseRef: "main",
                  updatedAt: "1970-01-01T00:00:00.000Z",
                  mergedAt: "1970-01-01T00:00:00.000Z",
                },
          ),
      }),
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

const layerRetention = layerRetentionBase.pipe(Layer.provide(layerIdentity));

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

it.effect("pages through finished workers from before the cutoff", () =>
  Effect.gen(function* () {
    const { service, projections, seed } = yield* makeFixture();
    for (let index = 0; index < 32; index++) {
      yield* seed(`finished-${index.toString().padStart(2, "0")}`, "merged");
    }
    const last = yield* seed("finished-next-page", "merged");
    const first = yield* service.autoArchive();
    assert.equal(first.archived, 32);
    assert.isNull((yield* projections.getThread(last)).archivedAt);
    const second = yield* service.autoArchive(undefined, first.cursor);
    assert.equal(second.archived, 1);
    assert.isNotNull((yield* projections.getThread(last)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

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

it.effect(
  "archives only finished workers and keeps restored workers active until new work finishes",
  () =>
    Effect.gen(function* () {
      const { sql, service, orchestrator, projections, createdAt, parent, seed } =
        yield* makeFixture();
      const done = yield* seed("done", "merged");
      const open = yield* seed("open", "open");
      const queued = yield* seed("queued", "merged");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('queued-run', ${queued}, 1, 'codex', 'queued', ${DateTime.formatIso(createdAt)}, '{}')`;
      const owner = yield* seed("owner-child", "merged", { createdBy: "user" });
      const root = yield* seed("orchestrator", "merged", { role: "orchestrator" });
      const writer = yield* seed("backlog-writer", "merged", { role: "writer" });
      const sideChat = yield* seed("side-chat", "merged", {
        lineage: {
          rootThreadId: parent,
          parentThreadId: parent,
          relationshipToParent: "subagent",
          sideChat: true,
        },
      });
      assert.equal((yield* service.autoArchive()).archived, 1);
      assert.isNotNull((yield* projections.getThread(done)).archivedAt);
      for (const thread of [open, queued, owner, root, writer, sideChat]) {
        assert.isNull((yield* projections.getThread(thread)).archivedAt, thread);
      }

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

it.effect("archives temporary workers after delivery or parent archive when they are idle", () =>
  Effect.gen(function* () {
    const { service, projections, orchestrator, sink, sql, parent, createdAt, seed } =
      yield* makeFixture();
    const worktreePath = "/workspace/worktree";
    yield* seed(parent, "open", {
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
      worktreePath,
    });
    const delivered = yield* seed("reviewer-delivered", "open", {
      role: "reviewer",
      pullRequests: [],
    });
    // The parent's open PR and issue reach a child in its checkout through the shared branch.
    const branchLinks = {
      branch: "feature",
      pullRequests: [],
      branchPullRequest: {
        projectId,
        repository: "owner/project",
        number: 42,
        url: "https://github.com/owner/project/pull/42",
      },
      issues: [
        {
          tracker: IssueTrackerKind.make("github"),
          host: "github.com",
          scope: "owner/project",
          key: "44",
          projectId,
          displayKey: "#44",
          title: "Issue",
          url: "https://github.com/owner/project/issues/44",
          source: "agent" as const,
          linkedAt: DateTime.formatIso(createdAt),
        },
      ],
    };
    const sharedCheckout = yield* seed("reviewer-shared-checkout", "open", {
      role: "reviewer",
      worktreePath,
      ...branchLinks,
    });
    const ownCheckout = yield* seed("reviewer-own-checkout", "open", {
      role: "reviewer",
      worktreePath: "/workspace/own",
      ...branchLinks,
    });
    const pending = yield* seed("checker-pending", "open", { role: "reviewer", pullRequests: [] });
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.role', 'checker') WHERE thread_id = ${pending}`;
    const question = yield* seed("reviewer-question", "open", {
      role: "reviewer",
      pullRequests: [],
    });
    const openPr = yield* seed("reviewer-open-pr", "open", { role: "reviewer" });
    const writer = yield* seed("writer-delivered", "open", { role: "writer", pullRequests: [] });

    const recordTask = Effect.fn("WorkerRetention.test.recordTask")(function* (
      owner: ThreadId,
      child: ThreadId,
      delivery: "delivered" | "pending",
      status: "completed" | "running" = "completed",
    ) {
      const driver = ProviderDriverKind.make("codex");
      const id = NodeId.make(`task:${child}`);
      yield* sink.write({
        events: [
          {
            type: "subagent.updated",
            id: EventId.make(`event:${child}:${delivery}`),
            threadId: owner,
            nodeId: id,
            driver,
            providerInstanceId: instanceId,
            occurredAt: createdAt,
            payload: {
              id,
              threadId: owner,
              runId: null,
              parentNodeId: id,
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: child,
              nativeTaskRef: null,
              prompt: "Review",
              title: null,
              model: null,
              status,
              result: status === "completed" ? "Finished" : null,
              startedAt: createdAt,
              completedAt: status === "completed" ? createdAt : null,
              updatedAt: createdAt,
              completionDelivery: { state: delivery, observedByRunId: null },
            },
          },
        ],
      });
    });

    for (const child of [delivered, sharedCheckout, ownCheckout, question, openPr, writer]) {
      yield* recordTask(parent, child, "delivered");
    }
    yield* recordTask(parent, pending, "pending");
    const withOpenChild = yield* seed("designer-with-child", "open", {
      role: "designer",
      pullRequests: [],
    });
    yield* recordTask(parent, withOpenChild, "delivered");
    yield* recordTask(withOpenChild, ThreadId.make("open-child"), "pending", "running");
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('question', ${question}, 'question-node', 'user_input', 'pending',
              ${DateTime.formatIso(createdAt)}, '{}')`;

    yield* service.autoArchive();
    assert.isNotNull((yield* projections.getThread(delivered)).archivedAt);
    assert.isNotNull((yield* projections.getThread(sharedCheckout)).archivedAt);
    for (const child of [pending, ownCheckout, question, openPr, writer, withOpenChild]) {
      assert.isNull((yield* projections.getThread(child)).archivedAt, child);
    }

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-parent"),
      threadId: parent,
    });
    yield* service.autoArchive();
    assert.isNotNull((yield* projections.getThread(pending)).archivedAt);
    for (const child of [ownCheckout, question, openPr, writer, withOpenChild]) {
      assert.isNull((yield* projections.getThread(child)).archivedAt, child);
    }

    yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests
      WHERE thread_id = ${question}`;
    yield* service.autoArchive(question);
    assert.isNotNull((yield* projections.getThread(question)).archivedAt);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("restore-reviewer"),
      threadId: pending,
    });
    yield* service.autoArchive(pending);
    assert.isNull((yield* projections.getThread(pending)).archivedAt);

    yield* TestClock.adjust("14 days");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(delivered)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps expired Writers and unfinished workers", () =>
  Effect.gen(function* () {
    const { service, orchestrator, projections, createdAt, seed, sql } = yield* makeFixture();
    const sweep = yield* seed("open-sweep", "open", { archivedAt: createdAt });
    const locked = yield* seed("open-locked", "open", { archivedAt: createdAt });
    const writer = yield* seed("expired-writer", "merged", {
      role: "writer",
      archivedAt: createdAt,
    });
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
        (yield* projections.getThread(writer)).deletedAt === null,
      ],
      [true, true, true],
    );
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps pinned workers in both active and archive views", () =>
  Effect.gen(function* () {
    const { service, projections, createdAt, seed } = yield* makeFixture();
    const active = yield* seed("pinned-active", "merged", { pinnedAt: createdAt });
    const archived = yield* seed("pinned-archived", "merged", {
      pinnedAt: createdAt,
      archivedAt: createdAt,
    });
    yield* service.autoArchive();
    yield* TestClock.adjust("15 days");
    yield* service.removeExpired();
    assert.deepEqual(
      [
        (yield* projections.getThread(active)).archivedAt === null,
        (yield* projections.getThread(archived)).deletedAt === null,
      ],
      [true, true],
    );
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps a worker with a background command in its parent's provider session", () =>
  Effect.gen(function* () {
    const { service, sink, createdAt, parent, projections, seed } = yield* makeFixture();
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
    assert.equal((yield* service.autoArchive()).archived, 0);
    assert.isNull((yield* projections.getThread(worker)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("archives pre-cutoff work and rejects obsolete completion for a new worker", () =>
  Effect.gen(function* () {
    const { service, sink, projections, seed, cutoff } = yield* makeFixture();
    const now = yield* DateTime.now;
    const oldWorker = yield* seed("older-worker", "merged", {}, cutoff);
    const freshWorker = yield* seed(
      "newer-worker",
      "merged",
      { createdAt: now, updatedAt: now },
      now,
    );
    yield* TestClock.adjust("1 second");
    const later = yield* DateTime.now;
    for (const [threadId, requestedAt] of [
      [oldWorker, cutoff],
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
      [false, true],
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
    assert.equal((yield* service.autoArchive()).archived, 0);
    assert.isNull((yield* projections.getThread(worker)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("discovers branch completion only in the project repository", () =>
  Effect.gen(function* () {
    const { service, seed, projections, createdAt } = yield* makeFixture();
    const own = yield* seed("own-pr", "open", {
      pullRequests: [],
      branch: "own",
      worktreePath: "/workspace/missing-worktree",
    });
    const foreign = yield* seed("foreign-pr", "open", { pullRequests: [], branch: "foreign" });
    const archived = yield* seed("foreign-archived-pr", "open", {
      pullRequests: [],
      branch: "foreign",
      archivedAt: createdAt,
    });
    yield* service.autoArchive();
    yield* TestClock.adjust("15 days");
    yield* service.removeExpired();
    assert.deepEqual(
      [
        (yield* projections.getThread(own)).archivedAt !== null,
        (yield* projections.getThread(foreign)).archivedAt,
        (yield* projections.getThread(archived)).deletedAt,
      ],
      [true, null, null],
    );
  }).pipe(Effect.provide(layerRetention)),
);

it.effect(
  "archives completed issues and discovered pull requests while keeping open or unresolved links visible",
  () =>
    Effect.gen(function* () {
      const { service, projections, seed } = yield* makeFixture();
      const branchWorker = yield* seed("branch", "open", {
        pullRequests: [],
        branchPullRequest: {
          projectId: ProjectId.make("project:worker"),
          repository: "owner/project",
          number: 43,
          url: "https://github.com/owner/project/pull/43",
        },
      });
      const link = (key: string) => ({
        projectId,
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "owner/project",
        key,
        displayKey: `#${key}`,
        title: "Issue",
        url: `https://github.com/owner/project/issues/${key}`,
        source: "agent" as const,
        linkedAt: "1969-12-31T00:00:00.000Z",
      });
      const closed = yield* seed("closed-issue", "open", {
        pullRequests: [],
        issues: [link("43")],
      });
      const openPr = yield* seed("open-pr-closed-issue", "open", { issues: [link("43")] });
      const openIssue = yield* seed("open-issue-merged-pr", "merged", { issues: [link("44")] });
      const unknown = yield* seed("unknown-issue-merged-pr", "merged", { issues: [link("42")] });
      assert.equal((yield* service.autoArchive()).archived, 2);
      for (const thread of [branchWorker, closed]) {
        assert.isNotNull((yield* projections.getThread(thread)).archivedAt, thread);
      }
      for (const thread of [openPr, openIssue, unknown]) {
        assert.isNull((yield* projections.getThread(thread)).archivedAt, thread);
      }
    }).pipe(Effect.provide(layerRetention)),
);

it.effect.each(["timeout", "failed exit"] as const)(
  "defers archive and deletion after a Git %s during repository identification",
  (failure) => {
    let gitAvailable = false;
    let rootProbes = 0;
    const layerFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => FileSystem.makeNoop({ stat: () => fs.stat(".") })),
    ).pipe(Layer.provide(NodeFileSystem.layer));
    const layerRunner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: ({ args, timeoutBehavior }) => {
        const operation = args[2];
        if (operation === "rev-parse") rootProbes++;
        const failed = !gitAvailable && operation === "rev-parse";
        const timeout = failed && failure === "timeout";
        if (timeout && timeoutBehavior !== "timedOutResult") {
          return Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: "git",
              argumentCount: args.length,
              timeoutMs: 60_000,
            }),
          );
        }
        return Effect.succeed({
          stdout: failed
            ? ""
            : operation === "rev-parse"
              ? `${workspaceRoot}\n`
              : operation === "remote"
                ? "origin\thttps://github.com/owner/project.git (fetch)\n"
                : "",
          stderr: failed && !timeout ? "fatal: bad config line\n" : "",
          code: timeout
            ? null
            : ChildProcessSpawner.ExitCode(failed ? 128 : operation === "config" ? 1 : 0),
          timedOut: timeout,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });
    const identities = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(Layer.mergeAll(layerRunner, layerFileSystem, Path.layer)));

    return Effect.gen(function* () {
      const { service, seed, createdAt, projections } = yield* makeFixture();
      const worker = yield* seed("unidentified", "open", { pullRequests: [], branch: "own" });
      const other = yield* seed("unidentified-other", "open", {
        pullRequests: [],
        branch: "other",
      });
      const archived = yield* seed("archived", "open", {
        pullRequests: [],
        branch: "own",
        archivedAt: createdAt,
      });
      const archivedOther = yield* seed("archived-other", "open", {
        pullRequests: [],
        branch: "other",
        archivedAt: createdAt,
      });
      yield* TestClock.adjust("15 days");
      yield* service.autoArchive();
      gitAvailable = true;
      yield* service.autoArchive();
      yield* service.removeExpired();
      assert.equal(
        rootProbes,
        1,
        "Both sweeps share the failed checkout probe during its cooldown",
      );
      assert.isNull((yield* projections.getThread(worker)).archivedAt);
      assert.isNull((yield* projections.getThread(other)).archivedAt);
      assert.isNull((yield* projections.getThread(archived)).deletedAt);
      assert.isNull((yield* projections.getThread(archivedOther)).deletedAt);

      yield* TestClock.adjust("1 minute");
      yield* service.removeExpired();
      assert.equal(rootProbes, 2, "The cleanup sweep refreshes a shared checkout once");
      assert.isNotNull((yield* projections.getThread(archived)).deletedAt);
      assert.isNotNull((yield* projections.getThread(archivedOther)).deletedAt);

      yield* service.autoArchive();
      assert.isNotNull((yield* projections.getThread(worker)).archivedAt);
      assert.isNotNull((yield* projections.getThread(other)).archivedAt);
    }).pipe(Effect.provide(layerRetentionBase.pipe(Layer.provide(identities))));
  },
);
