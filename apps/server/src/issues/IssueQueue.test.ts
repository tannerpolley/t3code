import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { McpSchema, McpServer } from "effect/ai";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OwnerDecisions from "./OwnerDecisions.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitManager from "../git/GitManager.ts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  RepositoryChildrenStatus,
  RuntimeRequestId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2Run,
  type PullRequestComment,
  type ThreadRole,
} from "@t3tools/contracts";
import * as IssueInbox from "./IssueInbox.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { sourceMarker } from "./IssueInboxRules.ts";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionReplay from "../orchestration-v2/testkit/ProjectionReplay.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "../orchestration-v2/PullRequestWatchReactor.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "./IssueService.ts";
import * as GitHubApi from "./IssueGitHubApi.ts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as IssueWorkService from "./IssueWorkService.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "../orchestration-v2/ThreadLaunchService.testHarness.ts";

const reference = { host: "github.com", repository: "owner/repo" };
const issue = (number: number) => ({
  ...reference,
  repositoryId: "queue-repo",
  id: `issue:${number}`,
  nodeId: `node:${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/owner/repo/issues/${number}`,
});
const read = (number: number) => ({
  issue: issue(number),
  state: "open" as const,
  milestoneNumber: null,
  parent: null,
  subIssues: [],
  blockedBy: [],
  parentComplete: true,
  subIssuesComplete: true,
  blockersComplete: true,
});
const reads = Layer.mock(IssueService.IssueService)({
  resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
  workRead: (input) =>
    Effect.succeed({ ...read(input.number), state: input.number === 99 ? "closed" : "open" }),
  repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: "queue-repo" }),
});
const projectRepositoryIdentity = {
  provider: SourceControlProviderKind.make("github"),
  canonicalKey: "github.com/owner/repo",
  displayName: "owner/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/owner/repo.git",
  },
};
function harness(
  issueReads = reads,
  candidateScan?: Deferred.Deferred<void>,
  databaseLayer?: typeof SqlitePersistence.layerMemory,
) {
  const base = makeHarness({
    ...(databaseLayer === undefined ? {} : { databaseLayer }),
    providers: [
      {
        instanceId: adapter.instanceId,
        driver: adapter.driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-23T00:00:00Z",
        availability: "available",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    serverSettings: {
      modelRoles: { implementor: { complex: { provider: "codex", effort: "default" } } },
      modelTiers: { 2: { codex: { model: modelSelection.model } } },
    },
    issueServiceLayer: issueReads,
    projectRepositoryIdentity,
    localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
  });
  const dependencies = Layer.mergeAll(
    base.layer,
    issueReads,
    IssueWorkStore.layer.pipe(Layer.provide(base.layer)),
    ProjectionStore.layer.pipe(Layer.provide(base.layer)),
    IdAllocator.layer,
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
  );
  const executor = Layer.succeed(
    EffectWorker.OrchestrationEffectExecutorV2,
    EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
  );
  return Layer.mergeAll(
    Layer.merge(ProjectionMaintenance.layer, ProjectionReplay.layer).pipe(
      Layer.provide(Layer.merge(dependencies, EventStore.layer.pipe(Layer.provide(dependencies)))),
    ),
    IssueWorkService.layer.pipe(
      Layer.provide(
        candidateScan === undefined
          ? Layer.empty
          : Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.map(ThreadManagement.ThreadManagementService, (threads) => ({
                ...threads,
                listProjectThreads: (input) =>
                  threads
                    .listProjectThreads(input)
                    .pipe(Effect.tap(() => Deferred.succeed(candidateScan, undefined))),
              })),
            ).pipe(Layer.provide(base.layer)),
      ),
      Layer.provide(dependencies),
    ),
    ProviderRuntimeRecovery.layer.pipe(Layer.provide(dependencies)),
    EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
      Layer.provide(Layer.mergeAll(dependencies, executor)),
    ),
  ).pipe(Layer.provideMerge(dependencies));
}

function inboxService(
  overrides: Partial<IssueService.IssueService["Service"]>,
  rest: (input: { readonly path: string }) => Effect.Effect<{
    readonly body: string;
    readonly status: number;
    readonly etag: string | null;
    readonly nextPage: number | null;
  }>,
) {
  return Layer.effect(
    IssueService.IssueService,
    Effect.gen(function* () {
      const service = yield* IssueService.make();
      return IssueService.IssueService.of({ ...service, ...overrides });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          withVerifiedCredential: (_input, use) =>
            use({ accountId: "test", viewer: "owner", credentialFingerprint: "test" }),
        }),
        Layer.mock(GitHubApi.GitHubApi)({
          rest: (input) =>
            Effect.gen(function* () {
              const response = yield* rest({ path: input.path.split("/").slice(3).join("/") });
              return { ...response, truncated: false, invalidUtf8: false, headers: {} };
            }),
        }),
      ),
    ),
  );
}
it.effect("hands SQLite connections to waiting queue calls before new borrows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-141-" });
    const observations: Record<string, string | undefined> = {};
    for (const connection of ["reader", "writer"] as const) {
      yield* Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const sql = yield* SqlClient.SqlClient;
        yield* createRoot();
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        let arrivals = 0;
        const order: string[] = [];
        const onConnection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          connection === "reader" ? effect.pipe(NodeSqliteClient.readOnly) : effect;
        const producer = yield* sql
          .withTransaction(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(
            onConnection,
            Effect.andThen(
              Effect.gen(function* () {
                for (let i = 0; i < 20; i++) {
                  yield* sql`SELECT 1`.pipe(onConnection);
                  order.push(`producer:${i}`);
                }
              }),
            ),
            Effect.forkChild,
          );
        yield* Deferred.await(held);
        const queues = yield* Effect.forEach([1, 2, 3], (number) => {
          let arrived = false;
          let acquired = false;
          const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              if (!acquired && span.attributes.get("db.connection") === connection) {
                acquired = true;
                order.push(`queue:${number}`);
              }
              end(time, exit);
            };
            const query = statement.compile()[0];
            if (
              !arrived &&
              (connection === "reader" ||
                query.includes("SELECT root_thread_id, project_id, paused, revision"))
            ) {
              arrived = true;
              arrivals++;
              if (arrivals === 3)
                return Deferred.succeed(waiting, undefined).pipe(Effect.as(statement));
            }
            return Effect.succeed(statement);
          };
          return service
            .queueIssue(input(number))
            .pipe(
              Effect.provideService(Statement.CurrentTransformer, observe),
              Effect.provideService(Statement.SpanPropagationEnabled, true),
              (effect) => Effect.forkChild(effect, { startImmediately: true }),
            );
        });
        yield* Deferred.await(waiting);
        const cancelled = yield* sql
          .withTransaction(sql`SELECT 1`)
          .pipe(onConnection, (effect) => Effect.forkChild(effect, { startImmediately: true }));
        yield* Fiber.interrupt(cancelled);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(producer);
        yield* Effect.forEach(queues, Fiber.join);
        observations[connection] = order[0]?.split(":")[0];
        assert.lengthOf((yield* service.repositoryStatus(reference)).queue!, 3);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      }).pipe(
        Effect.provide(
          harness(
            reads,
            undefined,
            SqlitePersistence.layerFromPath(path.join(directory, `${connection}.sqlite`)).pipe(
              Layer.provide(NodeServices.layer),
              Layer.orDie,
            ),
          ),
        ),
      );
    }
    assert.deepEqual(observations, { reader: "queue", writer: "queue" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
const rootId = ThreadId.make("queue-root");

it.effect("reads repository status while a write transaction holds the writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "issue-status-reader-" });
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("status-root-create"),
        threadId: rootId,
        projectId,
        title: "Status orchestrator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        repositoryOrchestration: {
          ...reference,
          repositoryId: "queue-repo",
          projectId,
          launchCommandId: CommandId.make("status-root-create"),
          revision: 1,
          paused: true,
          workerLimit: 1,
          readOnlyLimit: 4,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
        },
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const before = yield* service.repositoryStatus(reference);
      assert.equal(before.rootThreadId, rootId);
      assert.isNotNull(before.orchestration);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE orchestration_v2_projection_repository_orchestration SET paused = 0 WHERE root_thread_id = ${rootId}`;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      // Releasing only after the read completes deadlocks if any status query uses the writer.
      const during = yield* service
        .repositoryStatus(reference)
        .pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      assert.deepEqual(during, before);
      yield* Fiber.join(writer);
    }).pipe(
      Effect.provide(
        harness(
          reads,
          undefined,
          SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
            Layer.orDie,
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
const input = (number: number, key = `enqueue:${number}`) => ({
  ...reference,
  number,
  clientRequestId: CommandId.make(key),
});
const finish = (
  run: OrchestrationV2Run,
  key: string,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(key),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
  });

it.effect("uses the Orchestrator and worker provider selections independently", () => {
  const claude = {
    ...adapter,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
  };
  const adapters = [adapter, claude];
  const base = makeHarness({
    adapters,
    providers: adapters.map((entry): ServerProvider => ({
      instanceId: entry.instanceId,
      driver: entry.driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    })),
    issueServiceLayer: reads,
    projectRepositoryIdentity,
    localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
    serverSettings: {
      modelRoles: {
        orchestrator: { complex: { provider: "codex", effort: "default" } },
        implementor: { complex: { provider: "claude", effort: "default" } },
      },
      modelTiers: {
        2: { codex: { model: modelSelection.model }, claude: { model: "claude-sonnet-4-6" } },
      },
    },
  });
  const dependencies = Layer.mergeAll(
    base.layer,
    reads,
    IssueWorkStore.layer.pipe(Layer.provide(base.layer)),
    IdAllocator.layer,
  );
  return Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const started = yield* service.start({
      ...input(1, "worker-provider:root"),
      projectId,
      modelRoleId: "implementor-complex",
      createOrchestrator: true,
    });
    assert.deepEqual(
      (yield* threads.getThreadRecords(started.rootThreadId, [])).thread.modelSelection,
      modelSelection,
    );
    assert.equal(
      (yield* store.latestRequest(issue(1)))!.modelSelection.instanceId,
      claude.instanceId,
    );
  }).pipe(Effect.provide(IssueWorkService.layer.pipe(Layer.provideMerge(dependencies))));
});

it.effect(
  "persists ordered requests without an orchestrator; enqueue, dequeue and retries are idempotent and separate from Start",
  () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(2));
      yield* service.queueIssue(input(1, "duplicate"));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2],
      );
      assert.isNull(yield* store.latestRequest(issue(1)));
      assert.isNull(yield* store.request(input(1).clientRequestId));
      yield* service.unqueueIssue(input(1, "remove"));
      yield* service.unqueueIssue(input(1, "remove"));
      yield* service.queueIssue(input(1));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
      yield* service.queueIssue(input(1, "again"));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2, 1],
      );
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      assert.equal(
        (yield* service.queueIssue(input(99)).pipe(Effect.flip)).code,
        "invalid-request",
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "a queued issue starts its own worker while the root is busy; a blocked one waits",
  () => {
    const blocked = new Set([2]);
    const closed = new Set<number>();
    const relationships = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      workRead: (input) =>
        Effect.sync(() => ({
          ...read(input.number),
          state: closed.has(input.number) ? ("closed" as const) : ("open" as const),
          blockedBy: blocked.has(input.number)
            ? [{ issue: issue(50), state: "open" as const }]
            : [],
        })),
      repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: "queue-repo" }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot();
      yield* service.queueIssue(input(3));
      closed.add(3);
      yield* service.setPaused({
        ...reference,
        paused: false,
        clientRequestId: CommandId.make("resume-queue"),
      });
      assert.deepEqual(yield* store.queue(reference), []);
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: rootId,
        commandId: CommandId.make("busy-root"),
        messageId: MessageId.make("busy-root"),
        text: "Keep orchestrating",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* service.queueIssue(input(2));
      yield* service.queueIssue(input(1));
      yield* worker.drain();
      assert.isNull(yield* store.issueOwner(issue(2)));
      assert.isNotNull(yield* store.issueOwner(issue(1)));
      assert.equal(yield* store.slotsInUse(rootId), 1);
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      blocked.clear();
      yield* service.reconcile(rootId);
      yield* worker.drain();
      assert.isNotNull(yield* store.issueOwner(issue(2)));
      assert.deepEqual(yield* store.queue(reference), []);
      // The single slot stays with issue 1; issue 2's worker waits for it.
      assert.equal(yield* store.slotsInUse(rootId), 1);
    }).pipe(Effect.provide(harness(relationships)));
  },
);

it.effect.each([false, true])(
  "queued issue workers take a free slot ahead of earlier waiting workers (queued while paused: %s)",
  (pausedWhileQueued) =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot(false);
      const startIssue = (number: number, key: string) =>
        service.start({
          ...input(number, key),
          projectId,
          modelRoleId: "implementor-complex",
        });
      const setPaused = (paused: boolean) =>
        service.setPaused({
          ...reference,
          paused,
          clientRequestId: CommandId.make(`ordering-paused:${paused}`),
        });
      const runOf = (threadId: ThreadId) =>
        threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.map(({ runs }) => runs[0]!));
      yield* startIssue(3, "a-running-worker");
      yield* TestClock.adjust("1 second");
      // Sorts before the queue's request ids, so only the admission order can put issue 5 first.
      yield* startIssue(4, "a-waiting-worker");
      yield* TestClock.adjust("1 second");
      yield* worker.drain();
      const running = (yield* store.issueOwner(issue(3)))!;
      const earlier = (yield* store.issueOwner(issue(4)))!;
      assert.equal(yield* store.slotsInUse(rootId), 1);
      assert.equal((yield* runOf(earlier)).status, "queued");
      const sequence = yield* sink.latestSequence();
      if (pausedWhileQueued) {
        // The slot frees while paused; resuming must offer it to the queue entry first.
        yield* setPaused(true);
        yield* service.queueIssue(input(5));
        yield* finish(yield* runOf(running), "running-worker-finished");
        yield* worker.drain();
        assert.isNull(yield* store.issueOwner(issue(5)));
        yield* setPaused(false);
      } else {
        yield* service.queueIssue(input(5));
        const waiting = (yield* store.issueOwner(issue(5)))!;
        assert.equal((yield* runOf(waiting)).status, "queued");
        assert.deepEqual(yield* store.admissionThreads(rootId), [waiting, earlier]);
        yield* finish(yield* runOf(running), "running-worker-finished");
      }
      const queued = (yield* store.issueOwner(issue(5)))!;
      // Workspace preparation runs before admission; the first run to start took the freed slot.
      const [admitted] = yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter(
          (stored) =>
            (stored.event.type === "run.updated" || stored.event.type === "run.created") &&
            (stored.event.threadId === queued || stored.event.threadId === earlier) &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(admitted!.event.threadId, queued);
      yield* worker.drain();
      assert.equal((yield* runOf(earlier)).status, "queued");
      assert.equal(yield* store.slotsInUse(rootId), 1);
    }).pipe(Effect.provide(harness())),
);

const createRoot = (paused = true) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-root"),
      threadId: rootId,
      projectId,
      title: "Queue root",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      repositoryOrchestration: {
        ...reference,
        repositoryId: "queue-repo",
        projectId,
        launchCommandId: CommandId.make("create-root"),
        revision: 1,
        paused,
        workerLimit: 1,
        readOnlyLimit: 4,
        publishStatusComments: false,
        publishCloseoutComments: false,
        milestones: [],
        suspendedIssues: [],
      },
    });
  });

const startWatchTestWorker = Effect.fn("test.startWatchTestWorker")(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = yield* IssueWorkStore.IssueWorkStore;
  yield* createRoot(false);
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("pr-watch-root-start"),
    threadId: rootId,
    messageId: MessageId.make("pr-watch-root-start"),
    text: "Start issue work",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parentRun = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
  yield* threads.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("pr-watch-delegate"),
    parentThreadId: rootId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    issue: issue(1),
    role: "implementor",
    task: "Implement issue 1",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  return (yield* store.issueOwner(issue(1)))!;
});

it.effect(
  "starts one managed watch for a previously discovered stack link and honors unwatch",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = yield* startWatchTestWorker();
      const key = { host: "github.com", repository: "owner/repo", number: 12 };
      const url = "https://github.com/owner/repo/pull/12";
      const now = yield* DateTime.now;
      const linkedAt = DateTime.formatIso(now);
      const { thread } = yield* threads.getThreadRecords(threadId, []);
      const snapshot = {
        state: "open" as const,
        title: "Stack layer",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: linkedAt,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("previous-stack-link"),
            type: "thread.pull-request-synced",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              pullRequests: [{ ...key, url, linkedAt, source: "stack", snapshot, stack: null }],
            },
          },
        ],
      });
      const link = (commandId: string) =>
        threads.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(commandId),
          threadId,
          ...key,
          url,
          source: "agent",
        });
      yield* link("link-existing-stack-pr");
      const links = threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.map(({ thread }) => thread.pullRequests));
      const started = yield* links;
      assert.lengthOf(started!, 1);
      assert.exists(started?.[0]?.watch);
      yield* TestClock.adjust("1 second");
      yield* link("relink-watched-stack-pr");
      assert.deepEqual(yield* links, started);
      yield* threads.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("unwatch-stack-pr"),
        threadId,
        ...key,
        watching: false,
      });
      yield* link("relink-unwatched-stack-pr");
      yield* threads.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("sync-unwatched-stack-pr"),
        threadId,
        ...key,
        snapshot,
        stack: null,
      });
      assert.isUndefined((yield* links)?.[0]?.watch);
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("discover-new-stack-pr"),
        threadId,
        ...key,
        number: 13,
        url: "https://github.com/owner/repo/pull/13",
        source: "stack",
      });
      assert.exists((yield* links)?.find((entry) => entry.number === 13)?.watch);
    }).pipe(Effect.provide(harness())),
);

it.effect.each([
  { draftPrRepositories: undefined, watched: true },
  { draftPrRepositories: "GitHub.com/Owner/Repo", watched: false },
])(
  "managed worker PR watch with draft PR repositories $draftPrRepositories",
  ({ draftPrRepositories, watched }) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const threadId = yield* startWatchTestWorker();
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("link-worker-pr"),
        threadId,
        host: "github.com",
        repository: "owner/repo",
        number: 12,
        url: "https://github.com/owner/repo/pull/12",
        source: "agent",
      });
      const { thread } = yield* threads.getThreadRecords(threadId, []);
      assert.equal(thread.pullRequests?.[0]?.watch !== undefined, watched);
    }).pipe(
      Effect.provide(
        harness().pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env:
                  draftPrRepositories === undefined
                    ? {}
                    : { T3CODE_ISSUE_DRAFT_PR_REPOSITORIES: draftPrRepositories },
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect("does not rewrite an unchanged PR snapshot after a managed worker stops", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* startWatchTestWorker();
    const key = { ...reference, number: 12 };
    const url = "https://github.com/owner/repo/pull/12";
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    yield* finish(runs[0]!, "complete-before-pr-link");
    yield* threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-before-pr-link"),
      threadId,
    });
    yield* threads.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make("link-after-stop"),
      threadId,
      ...key,
      url,
      source: "created",
    });
    const reactor = yield* PullRequestSyncReactor.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({
            withSharedProjectReads: (effect) => effect,
            batchesReads: () => Effect.succeed(false),
            invalidate: () => Effect.void,
            summary: () =>
              Effect.succeed({
                provider: SourceControlProviderKind.make("github"),
                projectId,
                ...key,
                url,
                title: "Late pull request",
                state: "open",
                headBranch: "feature",
                baseBranch: "main",
                updatedAt: "1970-01-01T00:00:00.000Z",
                stack: null,
              }),
          }),
        ),
      ),
    );
    const link = threads
      .getThreadRecords(threadId, [])
      .pipe(Effect.map(({ thread }) => thread.pullRequests?.[0]));
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    const first = yield* link;
    assert.equal(first?.snapshot?.state, "open");
    assert.isUndefined(first?.watch);
    yield* TestClock.adjust("1 minute");
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    assert.equal((yield* link)?.snapshot?.syncedAt, first?.snapshot?.syncedAt);
  }).pipe(Effect.scoped, Effect.provide(harness())),
);

it.effect.each([
  { configuredRepository: undefined, checksPending: true },
  { configuredRepository: "other.example/acme/app", checksPending: true },
  { configuredRepository: " other.example/acme/app, GitHub.com/Acme/App ", checksPending: false },
  { configuredRepository: "github.com/acme/app", checksPending: true, reportsChecks: true },
])(
  "wakes a managed implementor on PR feedback ($configuredRepository, checks pending: $checksPending)",
  ({ configuredRepository, checksPending, reportsChecks }) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const threadId = yield* startWatchTestWorker();
      const repository = "acme/app";
      const url = `https://github.com/${repository}/pull/12`;
      const at = DateTime.formatIso(yield* DateTime.now);
      const comments: PullRequestComment[] = [];
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env:
                  configuredRepository === undefined
                    ? {}
                    : { T3CODE_PR_WATCH_NO_CHECKS_REPOSITORIES: configuredRepository },
              }),
            ),
            Layer.mock(PullRequestService.PullRequestService)({
              watchFingerprint: () =>
                Effect.sync(() => ({ status: "open", remarks: String(comments.length) })),
              invalidate: () => Effect.void,
              detail: () =>
                Effect.succeed({
                  provider: SourceControlProviderKind.make("github"),
                  capabilities: {
                    checksAlwaysReport: true,
                    diff: true,
                    comment: true,
                    actions: [],
                    mergeMethods: [],
                    search: false,
                    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
                    reviewers: { request: false, listCandidates: false },
                  },
                  viewerPermissions: {
                    actions: [],
                    comment: true,
                    resolve: true,
                    verdicts: [],
                    requestReviewers: false,
                  },
                  projectId,
                  projectTitle: "Queue root",
                  workspaceRoot: "/repo",
                  repository,
                  number: 12,
                  title: "Implement issue 1",
                  body: "",
                  url,
                  author: null,
                  state: "open",
                  isDraft: true,
                  mergeability: "mergeable",
                  additions: 1,
                  deletions: 0,
                  changedFiles: 1,
                  headBranch: "feature",
                  headSha: "abc1234",
                  baseBranch: "main",
                  createdAt: at,
                  updatedAt: at,
                  mergedAt: null,
                  closedAt: null,
                  reviewers: [],
                  labels: [],
                  checks: reportsChecks
                    ? [{ name: "review-bot", status: "pending", description: null, url: null }]
                    : [],
                  mergeCapabilities: { merge: true, squash: true, rebase: true },
                }),
              activity: () =>
                Effect.sync(() => ({
                  comments,
                  commentCount: comments.length,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                })),
            }),
          ),
        ),
      );
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("pr-watch-created"),
        threadId,
        host: "github.com",
        repository,
        number: 12,
        url,
        source: "created",
      });
      yield* reactor.sweep;
      const before = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      assert.equal(before.thread.pullRequests?.[0]?.watch?.checksPending, checksPending);
      yield* finish(before.runs[0]!, "pr-watch-worker-finished");
      yield* TestClock.adjust("1 minute");
      yield* reactor.sweep;

      comments.push({
        id: "review-1",
        kind: "review-comment",
        author: { login: "review-bot", name: null, avatarUrl: null },
        body: "Please handle an empty response.",
        createdAt: DateTime.formatIso(yield* DateTime.now),
        url: null,
        path: "src/main.ts",
        reviewState: null,
      });
      yield* reactor.sweep;
      const after = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      const wakes = after.messages.filter(
        (message) => message.notification?.source.kind === "monitor",
      );
      assert.lengthOf(wakes, 1);
      assert.include(wakes[0]!.text, comments[0]!.body);
      assert.equal(after.runs.find((run) => run.id === wakes[0]!.runId)?.status, "starting");
    }).pipe(Effect.provide(harness())),
);

const statusToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(OwnerDecisions.OwnerDecisions)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(PeerForwarding.PeerForwarding)({}),
      Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      Layer.mock(PeerLinks.PeerLinks)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
  Layer.provideMerge(harness()),
);

const statusScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("status-here"),
  requestNamespace: "repository-status-test",
  thread: {
    threadId: rootId,
    providerSessionId: "repository-status-test",
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const statusClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "repository-status-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "repository-status-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const decodeChildStatus = Schema.decodeUnknownEffect(RepositoryChildrenStatus);

const readChildStatus = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const result = yield* server
    .callTool({ name: "repository_status", arguments: {} })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, statusScope),
      Effect.provideService(McpSchema.McpServerClient, statusClient),
    );
  return yield* decodeChildStatus(result.structuredContent);
});

const startStatusRoot = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* createRoot(false);
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("status-root-run"),
    threadId: rootId,
    messageId: MessageId.make("status-root-message"),
    text: "Coordinate the work",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return yield* markStatusRunRunning(rootId);
});

const markStatusRunRunning = Effect.fn("IssueQueue.test.markStatusRunRunning")(function* (
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const {
    runs: [run],
  } = yield* threads.getThreadRecords(threadId, ["runs"]);
  const now = yield* DateTime.now;
  const running = { ...run!, status: "running" as const, startedAt: now };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`status-running:${threadId}`),
        type: "run.updated",
        threadId,
        runId: running.id,
        occurredAt: now,
        payload: running,
      },
    ],
  });
  return running;
});

it.effect("repository_status includes linked children from the local task projection", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = yield* startStatusRoot;
    const remoteChild = {
      environmentId: EnvironmentId.make("status-other-machine"),
      threadId: ThreadId.make("status-remote-child"),
      label: "Other machine",
      title: "Remote worker",
    };
    const started = yield* orchestrator.dispatch({
      type: "delegated_task.remote.request",
      commandId: CommandId.make("status-remote-delegate"),
      parentThreadId: rootId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Work on the linked machine",
      driver: ProviderDriverKind.make("codex"),
      modelSelection,
      remoteChild,
    });
    const task = started.storedEvents.find(({ event }) => event.type === "subagent.updated")?.event;
    assert.equal(task?.type, "subagent.updated");
    if (task?.type !== "subagent.updated") return;
    const link = formatThreadLink(remoteChild, remoteChild.title);
    const running = yield* readChildStatus;
    assert.deepEqual(
      running.working.map(({ threadId, link }) => ({ threadId, link })),
      [{ threadId: remoteChild.threadId, link }],
    );
    yield* orchestrator.dispatch({
      type: "delegated_task.remote.complete",
      commandId: CommandId.make("status-remote-failure"),
      parentThreadId: rootId,
      taskId: task.payload.id,
      status: "failed",
      result: "The linked worker failed.",
      stoppedThere: "ran-out",
    });
    const failed = yield* readChildStatus;
    assert.isEmpty(failed.working);
    assert.deepEqual(
      failed["needs-you"].map(({ link, lastSummary }) => ({ link, lastSummary })),
      [{ link, lastSummary: "The linked worker failed." }],
    );
  }).pipe(Effect.provide(statusToolkit)),
);

it.effect("repository_status rolls a grandchild approval up to the direct child", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const rootRun = yield* startStatusRoot;
    const delegate = Effect.fn("IssueQueue.test.delegateStatusChild")(function* (
      run: OrchestrationV2Run,
      key: string,
    ) {
      const launched = yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(key),
        parentThreadId: run.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Check the work",
        role: "reviewer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = launched.storedEvents.find(
        ({ event }) => event.type === "subagent.updated",
      )?.event;
      if (task?.type !== "subagent.updated" || task.payload.childThreadId === null) {
        return yield* Effect.die("Delegation did not launch a local child");
      }
      return yield* markStatusRunRunning(task.payload.childThreadId);
    });
    const child = yield* delegate(rootRun, "status-direct-child");
    const grandchild = yield* delegate(child, "status-grandchild");
    // A live direct child receives the request first. After it ends, the owner can answer.
    yield* finish(child, "status-direct-child-finished");
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("status-grandchild-approval"),
          type: "runtime-request.updated",
          threadId: grandchild.threadId,
          runId: grandchild.id,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("status-grandchild-request"),
            nodeId: grandchild.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        },
      ],
    });
    const status = yield* readChildStatus;
    assert.isEmpty(status.working);
    assert.deepEqual(
      status["needs-you"].map(({ threadId }) => threadId),
      [child.threadId],
    );
  }).pipe(Effect.provide(statusToolkit)),
);

it.effect(
  "status names both repository IDs when the repository was recreated under the same name",
  () => {
    let identityReads = 0;
    const recreated = Layer.mock(IssueService.IssueService)({
      repositoryIdentity: () =>
        Effect.sync(() => {
          identityReads += 1;
          return { ...reference, repositoryId: "recreated-repo" };
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      yield* createRoot(false);
      const status = yield* service.repositoryStatus(reference);
      assert.equal(status.phase, "active");
      assert.deepEqual(status.idMismatch, {
        registeredRepositoryId: "queue-repo",
        liveRepositoryId: "recreated-repo",
      });
      yield* service.repositoryStatus(reference);
      assert.equal(identityReads, 1);
    }).pipe(Effect.provide(harness(recreated as typeof reads)));
  },
);

it.effect("replays the original mailbox receipt after an orchestrator is registered", () =>
  Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    yield* service.queueIssue(input(1));
    yield* createRoot();
    const result = yield* service.queueIssue(input(1));
    assert.equal(result.rootThreadId, rootId);
    assert.deepEqual(
      result.queue?.map((entry) => entry.issue.number),
      [1],
    );
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  }).pipe(Effect.provide(harness())),
);

it.effect.each([true, false])(
  "a continuation emits nothing during a draining handoff (queued: %s)",
  (queued) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot();
      if (queued) yield* service.queueIssue(input(1));
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: rootId,
        commandId: CommandId.make("hold-root-busy"),
        messageId: MessageId.make("hold-root-busy"),
        text: "Finish current orchestration",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const config = (yield* service.repositoryStatus(reference)).orchestration!;
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("waiting-handoff"),
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          handoff: {
            requestId: CommandId.make("handoff"),
            nextThreadId: ThreadId.make("next-root"),
            summary: "Wait for current work",
            modelSelection,
            status: "draining",
            wasPaused: false,
          },
        },
      });
      yield* worker.drain();
      const sequence = yield* sink.latestSequence();
      const result = yield* threads.dispatch({
        type: "repository.work.continue",
        threadId: rootId,
        commandId: CommandId.make("no-work-continue"),
      });
      yield* worker.drain();
      assert.lengthOf(result.storedEvents, 0);
      assert.equal(yield* sink.latestSequence(), sequence);
    }).pipe(Effect.provide(harness())),
);

it.effect.each(["external", "bot", "listing"] as const)(
  "inbox closes remove queued entries through replayable queue commands (%s)",
  (origin) => {
    let closed = false;
    let listingCaughtUp = false;
    const github = inboxService(
      {
        resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
        // Blocked issues stay queued on an active root, so only the inbox removes them.
        workRead: (input) =>
          Effect.succeed({
            ...read(input.number),
            blockedBy: [{ issue: issue(50), state: "open" as const }],
          }),
      },
      (input) =>
        Effect.succeed({
          status: 200,
          etag: null,
          nextPage: null,
          body: JSON.stringify(
            !closed
              ? []
              : input.path.startsWith("issues/events") && origin !== "listing"
                ? [
                    ...[1, 2].map((number) => ({
                      id: number,
                      event: "closed",
                      created_at: "1970-01-01T00:00:01Z",
                      actor: {
                        login: origin === "bot" ? "automation[bot]" : "owner",
                        type: origin === "bot" ? "Bot" : "User",
                      },
                      issue: { number, title: `Issue ${number}`, html_url: issue(number).url },
                    })),
                    ...["closed", "reopened"].map((event, index) => ({
                      id: index + 3,
                      event,
                      created_at: "1970-01-01T00:00:01Z",
                      actor: { login: "owner", type: "User" },
                      issue: { number: 3, title: "Issue 3", html_url: issue(3).url },
                    })),
                  ]
                : input.path.startsWith("issues?")
                  ? [1, 2, 3].map((number) => ({
                      ...issue(number),
                      state:
                        number === 3 && (origin === "listing" || listingCaughtUp)
                          ? "open"
                          : "closed",
                      html_url: issue(number).url,
                      created_at: "1969-12-31T23:59:00Z",
                      updated_at: "1970-01-01T00:00:00Z",
                    }))
                  : [],
          ),
        }),
    );
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot(false);
      for (const number of [1, 2, 3]) yield* service.queueIssue(input(number));
      const inbox = yield* IssueInbox.make;
      yield* inbox.pollDue;
      closed = true;
      yield* TestClock.adjust("5 minutes");
      yield* inbox.pollDue;
      yield* worker.drain();
      listingCaughtUp = true;
      assert.deepEqual(
        (yield* inbox.list(reference)).events
          .filter((event) => event.issueNumber <= 2)
          .map((event) => event.kind),
        [],
      );
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
      yield* TestClock.adjust("5 minutes");
      yield* inbox.pollDue;
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
      assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
    }).pipe(Effect.provide(harness(github)));
  },
);

it.effect("rebuilds the same queue from queue, removal and worker claim events", () =>
  Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const verify = sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* store.queue(reference);
        assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
        assert.deepEqual(yield* store.queue(reference), before);
      }),
    );
    yield* createRoot();
    for (const number of [1, 2, 3]) yield* service.queueIssue(input(number));
    yield* service.unqueueIssue(input(3, "rebuild-remove"));
    yield* worker.drain();
    assert.deepEqual(
      (yield* store.queue(reference)).map((entry) => entry.issue.number),
      [1, 2],
    );
    yield* verify;
    yield* service.setPaused({
      ...reference,
      paused: false,
      clientRequestId: CommandId.make("rebuild-resume"),
    });
    yield* worker.drain();
    assert.deepEqual(yield* store.queue(reference), []);
    assert.isNotNull(yield* store.issueOwner(issue(1)));
    yield* verify;
  }).pipe(Effect.provide(harness())),
);

const createCandidate = (id: string, role?: ThreadRole) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(id);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${id}:create`),
      threadId,
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (role !== undefined) {
      const sink = yield* EventSink.EventSinkV2;
      const thread = (yield* threads.getThreadRecords(threadId, [])).thread;
      yield* sink.write({
        events: [
          {
            type: "thread.metadata-updated",
            id: EventId.make(`${id}:role`),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, role },
          },
        ],
      });
    }
  });

it.effect.each([false, true])(
  "queue automatically registers the most recent Orchestrator exactly once under concurrency (no candidate: %s)",
  (noCandidate) =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      if (!noCandidate) {
        yield* createCandidate("older-orchestrator");
        yield* TestClock.adjust("1 second");
        yield* createCandidate("recent-orchestrator", "orchestrator");
      }
      yield* TestClock.adjust("1 second");
      yield* createCandidate("newest-implementor", "implementor");
      yield* TestClock.adjust("1 second");
      yield* createCandidate("archived-orchestrator");
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archived-orchestrator:archive"),
        threadId: ThreadId.make("archived-orchestrator"),
      });
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      const sink = yield* EventSink.EventSinkV2;
      const sequence = yield* sink.latestSequence();
      yield* Effect.all([service.queueIssue(input(1)), service.queueIssue(input(2))], {
        concurrency: 2,
      });
      if (!noCandidate)
        yield* sink.stream({ afterSequence: sequence }).pipe(
          Stream.filter((stored) => stored.event.type === "repository.work.restored"),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(
        (yield* service.repositoryStatus(reference)).rootThreadId,
        noCandidate ? null : "recent-orchestrator",
      );
      const registrations =
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`;
      assert.lengthOf(registrations, noCandidate ? 0 : 1);
      if (!noCandidate) {
        // Adopting the root starts the issues that were already queued.
        const started = yield* sink.stream({ afterSequence: sequence }).pipe(
          Stream.filter((stored) => stored.event.type === "issue.work.requested"),
          Stream.take(2),
          Stream.runCollect,
        );
        assert.sameMembers(
          started.map((stored) =>
            stored.event.type === "issue.work.requested" ? stored.event.payload.issue.number : 0,
          ),
          [1, 2],
        );
        assert.isUndefined(
          (yield* threads.getThreadRecords(ThreadId.make("older-orchestrator"), [])).thread
            .repositoryOrchestration,
        );
        assert.equal((yield* service.queueIssue(input(1))).rootThreadId, "recent-orchestrator");
      }
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness())),
);

it.effect("does not register an orchestrator when replaying a withdrawn queue request", () =>
  Effect.gen(function* () {
    const candidateScan = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* service.queueIssue(input(1));
      yield* Deferred.await(candidateScan);
      yield* service.unqueueIssue(input(1, "withdraw-before-candidate"));
      yield* createCandidate("late-orchestrator");
      const replayed = yield* service.queueIssue(input(1));
      assert.isNull(replayed.rootThreadId);
      assert.deepEqual(replayed.queue, []);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        0,
      );
      const sequence = yield* sink.latestSequence();
      yield* service.queueIssue(input(1, "fresh-queue-transition"));
      yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter((stored) => stored.event.type === "repository.work.restored"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, "late-orchestrator");
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        1,
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness(reads, candidateScan)));
  }),
);

it.effect.each([false, true])(
  "queue and Inbox work register one root across mixed concurrent triggers (no candidate: %s)",
  (noCandidate) => {
    let arrived = false;
    const github = inboxService(
      {
        resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
        workRead: (input) => Effect.succeed(read(input.number)),
        repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: "queue-repo" }),
      },
      (input) =>
        Effect.succeed({
          status: 200,
          etag: null,
          nextPage: null,
          body: JSON.stringify(
            arrived && input.path.startsWith("issues?")
              ? [
                  {
                    number: 7,
                    title: "External issue",
                    state: "open",
                    user: { login: "owner", type: "User" },
                    body: sourceMarker({
                      project: "other",
                      repository: "github.com/owner/other",
                      thread: "other-thread",
                    }),
                    created_at: "1970-01-01T00:00:01Z",
                    updated_at: "1970-01-01T00:00:01Z",
                    html_url: "https://github.com/owner/repo/issues/7",
                    labels: [],
                    milestone: null,
                  },
                ]
              : [],
          ),
        }),
    );
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const sql = yield* SqlClient.SqlClient;
      if (!noCandidate) yield* createCandidate("inbox-orchestrator");
      else yield* createCandidate("inbox-implementor", "implementor");
      const inbox = yield* IssueInbox.make;
      const concurrentInbox = yield* IssueInbox.make;
      yield* inbox.pollDue;
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      arrived = true;
      yield* TestClock.adjust("15 minutes");
      yield* Effect.all(
        [
          inbox.pollDue,
          concurrentInbox.pollDue,
          service.queueIssue(input(1)),
          service.queueIssue(input(2)),
        ],
        { concurrency: 4 },
      );
      assert.equal(
        (yield* service.repositoryStatus(reference)).rootThreadId,
        noCandidate ? null : "inbox-orchestrator",
      );
      assert.lengthOf((yield* inbox.list(reference)).events, 1);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        noCandidate ? 0 : 1,
      );
      if (!noCandidate) {
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.lengthOf(
          (yield* threads.getThreadRecords(ThreadId.make("inbox-orchestrator"), ["messages"]))
            .messages,
          1,
        );
      }
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness(github)));
  },
);
