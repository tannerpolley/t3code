import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
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
import * as TrackerIssues from "../issue/IssueService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
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
      Layer.mock(TrackerIssues.IssueService)({}),
      Layer.mock(IssueService.IssueService)({
        issueStatuses: (refs) =>
          Effect.sync(() => {
            return refs
              .filter(({ number }) => number !== 42)
              .map((ref) => ({
                ...ref,
                state: ref.number === 43 ? ("closed" as const) : ("open" as const),
                closedAt: ref.number === 43 ? "1970-01-01T00:00:00.000Z" : null,
              }));
          }),
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

  const recordTask = Effect.fn("WorkerRetention.test.recordTask")(function* (
    owner: ThreadId,
    child: ThreadId,
    delivery: "delivered" | "acknowledged" | "claimed" | "pending" | "disposed" | undefined,
    status: "completed" | "failed" | "cancelled" | "running" | "interrupted" = "completed",
    endedAt = createdAt,
    options: {
      taskKey?: string;
      result?: string;
      startedAt?: DateTime.Utc;
      updatedAt?: DateTime.Utc;
    } = {},
  ) {
    const driver = ProviderDriverKind.make("codex");
    const id = NodeId.make(`task:${options.taskKey ?? child}`);
    const updatedAt = options.updatedAt ?? endedAt;
    yield* sink.write({
      events: [
        {
          type: "subagent.updated",
          id: EventId.make(`event:${id}:${delivery}:${DateTime.toEpochMillis(updatedAt)}`),
          threadId: owner,
          nodeId: id,
          driver,
          providerInstanceId: instanceId,
          occurredAt: updatedAt,
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
            result: options.result ?? (status === "completed" ? "Finished" : null),
            startedAt: options.startedAt ?? createdAt,
            completedAt: status === "running" ? null : endedAt,
            updatedAt,
            ...(delivery === undefined
              ? {}
              : { completionDelivery: { state: delivery, observedByRunId: null } }),
          },
        },
      ],
    });
  });

  const recordRun = Effect.fn("WorkerRetention.test.recordRun")(function* (
    id: string,
    threadId: ThreadId,
    status: "completed" | "cancelled" | "running" | "interrupted",
    startedAt: DateTime.Utc,
    delegatedTaskId?: NodeId,
    ordinal = 1,
  ) {
    const runId = RunId.make(id);
    yield* sink.write({
      events: [
        {
          type: "run.created",
          id: EventId.make(id),
          threadId,
          occurredAt: startedAt,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`prompt:${id}`),
            rootNodeId: null,
            ...(delegatedTaskId === undefined ? {} : { delegatedTaskId }),
            activeAttemptId: null,
            status,
            requestedAt: startedAt,
            startedAt: status === "cancelled" ? null : startedAt,
            completedAt: status === "running" ? null : startedAt,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

  return {
    sql,
    service,
    orchestrator,
    projections,
    sink,
    createdAt,
    parent,
    seed,
    recordTask,
    recordRun,
  };
});

it.effect("flags the #636 interrupted worker after its PR merged", () =>
  Effect.gen(function* () {
    const { service, projections, parent, seed, recordTask, recordRun, createdAt } =
      yield* makeFixture();
    yield* seed(parent, "open", {
      role: "orchestrator",
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    const mergedAt = DateTime.add(createdAt, { hours: 1 });
    const worker = yield* seed("interrupted-worker", "merged", {}, mergedAt);
    const interruptedAt = DateTime.add(mergedAt, { hours: 1 });
    yield* recordRun("interrupted-handoff", worker, "interrupted", interruptedAt);
    yield* recordTask(parent, worker, "disposed", "interrupted", interruptedAt);

    yield* service.remindMissedArchives();
    assert.isNull((yield* projections.getThread(worker)).archivedAt);
    const { messages } = yield* projections.getThreadRecords(parent, ["messages"]);
    assert.include(
      messages.map((message) => message.notification?.summary),
      "Finished children still visible (1)",
    );
    assert.include(messages[0]?.text, worker);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("flags finished children as a group after the grace period and never archives them", () =>
  Effect.gen(function* () {
    const { service, projections, parent, seed, recordTask } = yield* makeFixture();
    yield* seed(parent, "open", {
      role: "orchestrator",
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    const now = yield* DateTime.now;
    const children: ThreadId[] = [];
    for (let index = 0; index < 33; index++) {
      const recipient = index === 32 ? children[0]! : parent;
      const child = yield* seed(`finished-${index}`, "open", {
        pullRequests: [],
        role: "reviewer",
        lineage: {
          rootThreadId: parent,
          parentThreadId: recipient,
          relationshipToParent: "subagent",
        },
      });
      yield* recordTask(recipient, child, "delivered", "completed", now);
      children.push(child);
    }
    yield* service.remindMissedArchives();
    assert.isEmpty((yield* projections.getThreadRecords(parent, ["messages"])).messages);
    yield* TestClock.adjust("5 minutes");
    yield* service.remindMissedArchives();
    yield* service.remindMissedArchives();
    const { messages } = yield* projections.getThreadRecords(parent, ["messages"]);
    assert.lengthOf(messages, 1);
    assert.equal(messages[0]?.notification?.summary, "Finished children still visible (33)");
    assert.isEmpty((yield* projections.getThreadRecords(children[0]!, ["messages"])).messages);
    for (const child of children) {
      assert.include(messages[0]?.text, child);
      assert.isNull((yield* projections.getThread(child)).archivedAt);
    }
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("archives only eligible children and keeps restored children active", () =>
  Effect.gen(function* () {
    const { service, orchestrator, projections, parent, sql, createdAt, seed, recordTask } =
      yield* makeFixture();
    yield* seed(parent, "open", {
      role: "orchestrator",
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    const archive = (child: ThreadId, id: string = child) =>
      orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`archive:${id}`),
        threadId: child,
        archiveDelegatedWorker: true,
      });
    const done = yield* seed("done-open-pr", "open");
    const sameTurn = yield* DateTime.now;
    yield* recordTask(parent, done, "delivered", "completed", sameTurn);
    const pinned = yield* seed("pinned", "merged", { pinnedAt: createdAt });
    const writer = yield* seed("writer", "merged", { role: "writer" });
    const owner = yield* seed("owner", "merged", { createdBy: "user" });
    const queued = yield* seed("queued", "merged");
    const question = yield* seed("question", "merged");
    const approval = yield* seed("approval", "merged");
    const withChild = yield* seed("with-child", "merged");
    const waiting = yield* seed("waiting-for-delivery", "merged");
    yield* recordTask(parent, waiting, "pending");
    for (const child of [pinned, writer, owner, queued, question, approval, withChild]) {
      yield* recordTask(parent, child, "delivered");
    }
    yield* recordTask(withChild, ThreadId.make("open-child"), "pending", "running");
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('queued-run', ${queued}, 1, 'codex', 'queued', ${DateTime.formatIso(createdAt)}, '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('question', ${question}, 'question-node', 'user_input', 'pending',
              ${DateTime.formatIso(createdAt)}, '{}'),
             ('approval', ${approval}, 'approval-node', 'approval', 'pending',
              ${DateTime.formatIso(createdAt)}, '{}')`;

    yield* archive(done);
    assert.isNotNull((yield* projections.getThread(done)).archivedAt);
    for (const child of [pinned, writer, owner, queued, question, approval, withChild, waiting]) {
      yield* archive(child).pipe(Effect.flip);
      assert.isNull((yield* projections.getThread(child)).archivedAt, child);
    }
    yield* service.remindMissedArchives();
    assert.isEmpty((yield* projections.getThreadRecords(parent, ["messages"])).messages);
    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("restore-worker"),
      threadId: done,
    });
    yield* archive(done, "old-result").pipe(Effect.flip);
    yield* TestClock.adjust("1 second");
    yield* recordTask(parent, done, "delivered", "completed", yield* DateTime.now);
    yield* archive(done, "fresh-result");
    yield* TestClock.adjust("14 days");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(done)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect(
  "recovers worker archives for a completed handoff and expires its source at the cutoff",
  () =>
    Effect.gen(function* () {
      const { service, projections, sink, parent, seed, recordTask } = yield* makeFixture();
      const archivedAt = yield* DateTime.now;
      const successor = ThreadId.make("successor");
      const repositoryOrchestration = {
        projectId,
        host: "github.com",
        repository: "owner/project",
        repositoryId: "repo",
        launchCommandId: CommandId.make("launch"),
        revision: 1,
        paused: false,
        workerLimit: 1,
        readOnlyLimit: 1,
        publishStatusComments: false,
        publishCloseoutComments: false,
        milestones: [],
        suspendedIssues: [],
        retiredToThreadId: successor,
      };
      const archiveRoot = Effect.fnUntraced(function* (id: ThreadId, handedOff: boolean) {
        yield* seed(id, "open", {
          role: "orchestrator",
          lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
        });
        const thread = yield* projections.getThread(id);
        yield* sink.write({
          events: [
            {
              type: "thread.archived",
              id: EventId.make(`archived:${id}`),
              threadId: id,
              occurredAt: archivedAt,
              payload: {
                ...thread,
                archivedAt,
                repositoryOrchestration,
                ...(handedOff ? { handoffToThreadId: successor } : {}),
              },
            },
          ],
        });
      });
      yield* archiveRoot(parent, true);
      const replacement = ThreadId.make("archived-after-restore");
      yield* archiveRoot(replacement, false);
      const worker = yield* seed("finished-child", "open");
      const pinned = yield* seed("pinned-child", "open", { pinnedAt: archivedAt });
      yield* recordTask(parent, worker, "delivered");
      yield* recordTask(parent, pinned, "delivered");

      yield* service.remindMissedArchives();
      assert.isNotNull((yield* projections.getThread(worker)).archivedAt);
      assert.isNull((yield* projections.getThread(pinned)).archivedAt);
      yield* TestClock.adjust("13 days");
      yield* service.removeExpired();
      assert.isNull((yield* projections.getThread(parent)).deletedAt);
      yield* TestClock.adjust("1 day");
      yield* service.removeExpired();
      assert.isNotNull((yield* projections.getThread(parent)).deletedAt);
      assert.isNull((yield* projections.getThread(replacement)).deletedAt);
    }).pipe(Effect.provide(layerRetention)),
);

it.effect("archives during the running result wake and leaves the worker’s side chat active", () =>
  Effect.gen(function* () {
    const {
      sql,
      parent,
      seed,
      recordTask,
      recordRun,
      service,
      sink,
      createdAt,
      orchestrator,
      projections,
    } = yield* makeFixture();
    yield* seed(parent, "open", {
      lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    });
    const worker = yield* seed("claimed-worker", "open", { pullRequests: [] });
    const side = yield* seed("owner-side-chat", "open", {
      createdBy: "user",
      lineage: {
        rootThreadId: parent,
        parentThreadId: worker,
        relationshipToParent: "subagent",
        sideChat: true,
      },
    });
    yield* recordTask(parent, worker, "delivered", "completed", createdAt, {
      taskKey: "z-previous-task",
    });
    const followupTask = NodeId.make("task:a-newer-followup");
    yield* recordTask(parent, worker, "claimed", "completed", createdAt, {
      taskKey: "a-newer-followup",
    });
    yield* recordRun("child-followup-run", worker, "completed", createdAt, followupTask);
    const wake = RunId.make("archive-wake");
    const messageId = MessageId.make("archive-wake-message");
    yield* sink.write({
      events: [
        {
          type: "message.updated",
          id: EventId.make("archive-wake-message"),
          threadId: parent,
          runId: wake,
          occurredAt: createdAt,
          payload: {
            id: messageId,
            threadId: parent,
            runId: wake,
            nodeId: null,
            role: "user",
            text: "Child completed",
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            streaming: false,
            createdAt,
            updatedAt: createdAt,
            delegatedCompletion: {
              parentRunId: null,
              generation: 1,
              taskIds: [followupTask],
            },
          },
        },
      ],
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${wake}, ${parent}, 1, 'codex', 'queued', ${DateTime.formatIso(createdAt)},
        json_object('userMessageId', ${messageId}, 'startedAt', NULL)),
      ('side-chat-queue', ${side}, 1, 'codex', 'queued', ${DateTime.formatIso(createdAt)}, '{}')`;
    const archive = (commandId: string) =>
      orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(commandId),
        threadId: worker,
        archiveDelegatedWorker: true,
      });
    yield* archive("archive-before-wake").pipe(Effect.flip);
    yield* service.remindMissedArchives();
    assert.isEmpty(
      (yield* projections.getThreadRecords(parent, ["messages"])).messages.filter(
        (message) => message.notification?.source.kind === "system",
      ),
    );
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running',
      payload_json = json_set(payload_json, '$.startedAt', ${DateTime.formatIso(createdAt)})
      WHERE run_id = ${wake}`;
    yield* archive("archive-in-wake");
    assert.isNotNull((yield* projections.getThread(worker)).archivedAt);
    assert.isNull((yield* projections.getThread(side)).archivedAt);
    const [sideRun] = yield* sql<{ status: string }>`
      SELECT status FROM orchestration_v2_projection_runs WHERE run_id = 'side-chat-queue'`;
    assert.equal(sideRun?.status, "queued");
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("an acknowledgment of an old task cannot hide the current result", () =>
  Effect.gen(function* () {
    const { orchestrator, parent, seed, createdAt, recordTask, recordRun, projections } =
      yield* makeFixture();
    const worker = yield* seed("follow-up-worker", "open", { pullRequests: [] });
    const followUp = DateTime.add(createdAt, { hours: 1 });
    yield* recordTask(parent, worker, "delivered", "completed", followUp, {
      taskKey: "follow-up",
      startedAt: followUp,
    });
    yield* recordTask(parent, worker, "acknowledged", "completed", createdAt, {
      updatedAt: DateTime.add(followUp, { hours: 1 }),
    });
    yield* recordRun("follow-up", worker, "completed", followUp);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-follow-up"),
      threadId: worker,
      archiveDelegatedWorker: true,
    });
    assert.isNotNull((yield* projections.getThread(worker)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect.each(["overlapping cancellation", "unobserved failure"] as const)(
  "keeps the worker visible before delivery after %s",
  (example) =>
    Effect.gen(function* () {
      const { service, orchestrator, projections, parent, seed, recordTask, recordRun, createdAt } =
        yield* makeFixture();
      yield* seed(parent, "open", {
        lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
      });
      const worker = yield* seed("worker-with-undelivered-result", "open", { pullRequests: [] });
      const finishedAt = DateTime.add(createdAt, { minutes: 2 });
      const taskId = NodeId.make(`task:${worker}`);
      const status = example === "overlapping cancellation" ? "completed" : "failed";
      const result = status === "completed" ? "The original run finished." : "The worker failed.";
      yield* recordTask(
        parent,
        worker,
        example === "overlapping cancellation" ? "claimed" : undefined,
        status,
        finishedAt,
        { result },
      );
      yield* recordRun("original-run", worker, "completed", createdAt, taskId);
      if (example === "overlapping cancellation") {
        const cancelledAt = DateTime.add(createdAt, { minutes: 1 });
        yield* recordTask(parent, worker, "delivered", "cancelled", cancelledAt, {
          taskKey: "cancelled-followup",
          result: "Cancelled before start.",
        });
        yield* recordRun(
          "cancelled-followup",
          worker,
          "cancelled",
          cancelledAt,
          NodeId.make("task:cancelled-followup"),
          2,
        );
      }
      const archive = (commandId: string) =>
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(commandId),
          threadId: worker,
          archiveDelegatedWorker: true,
        });
      yield* service.remindMissedArchives();
      assert.isEmpty((yield* projections.getThreadRecords(parent, ["messages"])).messages);
      yield* archive("archive-before-observation").pipe(Effect.flip);
      assert.isNull((yield* projections.getThread(worker)).archivedAt);

      yield* recordTask(parent, worker, "acknowledged", status, finishedAt, { result });
      yield* archive("archive-after-observation");
      assert.isNotNull((yield* projections.getThread(worker)).archivedAt);
    }).pipe(Effect.provide(layerRetention)),
);

it.effect("expires an archived worker when its PR merged after the worker was restored", () =>
  Effect.gen(function* () {
    const { service, projections, parent, seed, recordTask, createdAt } = yield* makeFixture();
    const restoredAt = DateTime.add(createdAt, { minutes: 1 });
    const mergedAt = DateTime.add(createdAt, { minutes: 2 });
    const worker = yield* seed(
      "archived-after-restore",
      "merged",
      {
        workerUnarchivedAt: DateTime.formatIso(restoredAt),
        archivedAt: DateTime.add(createdAt, { minutes: 3 }),
      },
      mergedAt,
    );
    yield* recordTask(parent, worker, "delivered", "completed", createdAt);
    yield* TestClock.adjust("15 days");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(worker)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("keeps expired Writers and unfinished workers", () =>
  Effect.gen(function* () {
    const { service, orchestrator, projections, createdAt, seed, sql, recordTask } =
      yield* makeFixture();
    const sweep = yield* seed("open-sweep", "open", { archivedAt: createdAt });
    const locked = yield* seed("open-locked", "open", { archivedAt: createdAt });
    const writer = yield* seed("expired-writer", "merged", {
      role: "writer",
      archivedAt: createdAt,
    });
    const legacy = yield* seed("legacy-archived", "merged", { archivedAt: createdAt });
    yield* recordTask(legacy, ThreadId.make("legacy-descendant"), undefined);
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
    assert.isNotNull((yield* projections.getThread(legacy)).deletedAt);
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
    yield* service.remindMissedArchives();
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
    const { service, sink, createdAt, parent, projections, seed, recordTask, orchestrator } =
      yield* makeFixture();
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
    yield* recordTask(parent, worker, "delivered");
    yield* service.remindMissedArchives();
    assert.isEmpty((yield* projections.getThreadRecords(parent, ["messages"])).messages);
    yield* orchestrator
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-background-work"),
        threadId: worker,
        archiveDelegatedWorker: true,
      })
      .pipe(Effect.flip);
    assert.isNull((yield* projections.getThread(worker)).archivedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect("discovers legacy archived completion only in the project repository", () =>
  Effect.gen(function* () {
    const { service, seed, projections, createdAt } = yield* makeFixture();
    const own = yield* seed("own-pr", "open", {
      pullRequests: [],
      branch: "own",
      worktreePath: "/workspace/missing-worktree",
      archivedAt: createdAt,
    });
    const foreign = yield* seed("foreign-pr", "open", {
      pullRequests: [],
      branch: "foreign",
      archivedAt: createdAt,
    });
    yield* TestClock.adjust("15 days");
    yield* service.removeExpired();
    assert.isNotNull((yield* projections.getThread(own)).deletedAt);
    assert.isNull((yield* projections.getThread(foreign)).deletedAt);
  }).pipe(Effect.provide(layerRetention)),
);

it.effect.each(["timeout", "failed exit"] as const)(
  "defers legacy deletion after a Git %s during repository identification",
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
      yield* service.removeExpired();
      gitAvailable = true;
      yield* service.removeExpired();
      assert.equal(rootProbes, 1, "Cleanup shares the failed checkout probe during its cooldown");
      assert.isNull((yield* projections.getThread(archived)).deletedAt);
      assert.isNull((yield* projections.getThread(archivedOther)).deletedAt);

      yield* TestClock.adjust("1 minute");
      yield* service.removeExpired();
      assert.equal(rootProbes, 2, "The cleanup sweep refreshes a shared checkout once");
      assert.isNotNull((yield* projections.getThread(archived)).deletedAt);
      assert.isNotNull((yield* projections.getThread(archivedOther)).deletedAt);
    }).pipe(Effect.provide(layerRetentionBase.pipe(Layer.provide(identities))));
  },
);
