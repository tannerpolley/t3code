import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import { USAGE_LIMIT_SWITCH_HOLD_MS } from "./usageLimitRecoveryPending.ts";
import * as UsageLimitProviderSwitchWorker from "./UsageLimitProviderSwitchWorker.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { type ServerProvider, type ModelRole } from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type Project,
  EnvironmentId,
  CommandId,
  EventId,
  MessageId,
  TurnItemId,
  type ModelSelection,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";

import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

import * as Orchestrator from "./Orchestrator.ts";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadWorkspaceService from "./ThreadWorkspaceService.ts";
import * as WorktreeMcpService from "../mcp/WorktreeMcpService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

import * as Scheduler from "../scheduling/Scheduler.ts";

import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([providerInstance, alternateProviderInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
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
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "pingdotgg/t3code",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect.each(["deadline", "fingerprint lost", "fingerprint changed", "mixed-age remarks"])(
    "delivers edited cached review replies: %s",
    (mode) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projectId = ProjectId.make(`pr-watch-tail-project-${mode}`);
        const threadId = ThreadId.make(`runtime-pr-watch-tail-${mode}`);
        const now = yield* DateTime.now;
        const at = (minutes: number, seconds = 0) =>
          DateTime.formatIso(DateTime.add(now, { minutes, seconds }));
        const startedAt = at(0);
        yield* seedProject({
          projectId,
          title: "Watch edited replies",
          workspaceRoot: "/workspace/watch-tail",
          defaultModelSelection: null,
          createdAt: startedAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-tail-create-${mode}`),
          threadId,
          projectId,
          title: "Watch edited replies",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-tail-start-${mode}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
        const reply: PullRequestComment = {
          id: "reply-11",
          kind: "review-comment",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "Original feedback.",
          createdAt: at(-60),
          url: null,
          path: "src/index.ts",
          reviewState: null,
        };
        let replies = Array.from(
          { length: mode === "fingerprint changed" ? 2 : 1 },
          (_, index) => ({
            ...reply,
            id: `reply-${index}-11`,
          }),
        );
        const reviewThreads = replies.map((reply, index) => ({
          id: `review-thread-${index}`,
          path: "src/index.ts",
          line: index + 1,
          side: "right" as const,
          isResolved: false,
          isOutdated: false,
          comments: Array.from({ length: 10 }, (_, index) => ({
            ...reply,
            id: `${reply.id}-preview-${index}`,
          })),
          commentCount: 11,
          nextCommentsCursor: "after-10",
        }));
        let fingerprint: string | null = mode === "mixed-age remarks" ? null : "before";
        let failPage = false;
        let activityReads = 0;
        const pageReads: Array<{ threadId: string; cursor: string }> = [];
        const expectedPages = reviewThreads.map((thread) => ({
          threadId: thread.id,
          cursor: "after-10",
        }));
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadsWithPullRequests: () =>
                  projections
                    .getThreadsWithPullRequests()
                    .pipe(
                      Effect.map((threads) => threads.filter((thread) => thread.id === threadId)),
                    ),
              }),
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () =>
                  Effect.succeed(
                    fingerprint === null ? null : { status: "OPEN pending", remarks: fingerprint },
                  ),
                invalidate: () => Effect.void,
                detail: () =>
                  Effect.succeed({
                    ...watchedPullRequestDetail({ projectId, number: 12, at: startedAt }),
                    checks: [{ name: "test", status: "pending", description: null, url: null }],
                  }),
                activity: () =>
                  Effect.sync(() => {
                    activityReads += 1;
                    return {
                      comments: reviewThreads.flatMap((thread) => thread.comments),
                      commentCount: reviewThreads.length * 11,
                      commentsTruncated: true,
                      reviewThreadsTruncated: false,
                      reviewThreads,
                      commits: [],
                    };
                  }),
                threadComments: (input) =>
                  Effect.suspend(() => {
                    const index = reviewThreads.findIndex((thread) => thread.id === input.threadId);
                    assert.isAtLeast(index, 0);
                    pageReads.push({ threadId: input.threadId, cursor: input.cursor });
                    return failPage && index === 1
                      ? Effect.fail(
                          new PullRequestOperationError({
                            operation: "threadComments",
                            detail: "Page unavailable",
                          }),
                        )
                      : Effect.succeed({ comments: [replies[index]!], nextCursor: null });
                  }),
              }),
            ),
          ),
        );
        const messages = orchestrator
          .getThreadRecords(threadId, ["messages"])
          .pipe(Effect.map((records) => records.messages));
        const watch = orchestrator
          .getThreadShell(threadId)
          .pipe(Effect.map((thread) => thread?.pullRequests?.[0]?.watch));
        yield* reactor.sweep;
        const baseline = yield* watch;
        replies = replies.map((reply) => ({
          ...reply,
          body: "Edited feedback.",
          editedAt: at(0, 1),
        }));

        if (mode === "mixed-age remarks") {
          const thread = reviewThreads[0]!;
          const visibleReply = {
            ...thread.comments[0]!,
            body: "Edited visible feedback.",
            editedAt: at(2),
          };
          thread.comments[0] = visibleReply;
          yield* TestClock.adjust("5 minutes");
          yield* reactor.sweep;
          const intermediateWatch = yield* watch;
          const intermediatePageReads = [...pageReads];
          yield* TestClock.adjust("5 minutes");
          yield* reactor.sweep;
          const wakes = yield* messages;
          assert.isTrue(wakes.every((wake) => wake.notification?.summary === "#12: new comments"));
          assert.equal((yield* watch)?.remarksThrough, visibleReply.editedAt);
          assert.deepEqual((yield* watch)?.remarkIds, [visibleReply.id]);
          assert.deepEqual(pageReads, [...expectedPages, ...expectedPages]);
          const wakeText = wakes.map((wake) => wake.text).join("\n");
          for (const reply of [visibleReply, ...replies]) {
            assert.include(wakeText, reply.body);
            assert.equal(wakeText.split(reply.body).length - 1, 1);
          }
          // A watermark past the deep edit requires a fresh tail, even before its deadline.
          if (intermediateWatch?.remarksThrough === visibleReply.editedAt) {
            assert.deepEqual(intermediatePageReads, [...expectedPages, ...expectedPages]);
          } else {
            assert.equal(intermediateWatch?.remarksThrough, baseline?.remarksThrough);
          }
          yield* reactor.sweep;
          yield* TestClock.adjust("30 minutes");
          yield* reactor.sweep;
          assert.deepEqual(yield* messages, wakes);
          assert.equal((yield* watch)?.remarksThrough, visibleReply.editedAt);
          assert.deepEqual(pageReads, [...expectedPages, ...expectedPages, ...expectedPages]);
          return;
        }

        if (mode === "fingerprint changed") {
          yield* TestClock.adjust("1 minute");
          fingerprint = "after";
          failPage = true;
          yield* reactor.sweep;
          assert.deepEqual(yield* messages, []);
          assert.deepEqual(yield* watch, baseline);
          assert.deepEqual(pageReads, [...expectedPages, ...expectedPages]);
          yield* TestClock.adjust("2 seconds");
          // Neither deep edit changes the host fingerprint or the thread's comment count.
          replies = replies.map((reply, index) => ({
            ...reply,
            body: `Latest feedback ${index + 1}.`,
            editedAt: at(1, index + 1),
          }));
          failPage = false;
        } else {
          if (mode === "fingerprint lost") fingerprint = null;
          yield* TestClock.adjust(mode === "deadline" ? "29 minutes" : "5 minutes");
          yield* reactor.sweep;
          assert.deepEqual(pageReads, expectedPages);
          assert.deepEqual(yield* messages, []);
          // An activity read at five minutes must not move the tail's ten-minute deadline.
          assert.equal(activityReads, mode === "deadline" ? 1 : 2);
          yield* TestClock.adjust(mode === "deadline" ? "1 minute" : "5 minutes");
        }
        yield* reactor.sweep;
        const wakes = yield* messages;
        assert.deepEqual(
          wakes.map((message) => message.notification?.summary),
          ["#12: new comments"],
        );
        for (const reply of replies) {
          assert.include(wakes[0]?.text ?? "", reply.body);
        }
        assert.notInclude(wakes[0]?.text ?? "", "Original feedback.");
        assert.deepEqual(
          pageReads,
          Array.from(
            { length: mode === "fingerprint changed" ? 3 : 2 },
            () => expectedPages,
          ).flat(),
        );
        const latestReply = replies.at(-1)!;
        assert.equal((yield* watch)?.remarksThrough, latestReply.editedAt);
        assert.deepEqual((yield* watch)?.remarkIds, [latestReply.id]);
        yield* reactor.sweep;
        assert.lengthOf(yield* messages, 1);
        assert.lengthOf(pageReads, mode === "fingerprint changed" ? 6 : 2);
        yield* TestClock.adjust("30 minutes");
        yield* reactor.sweep;
        assert.lengthOf(yield* messages, 1);
        assert.lengthOf(pageReads, mode === "fingerprint changed" ? 8 : 3);
      }),
  );
});

it.layer(layerTest)("thread workspace handoffs", (it) => {
  const projectId = ProjectId.make("workspace-return-project");
  const workspaceRoot = "/workspace/root";
  const worktreePath = "/workspace/feature";
  const layerWorkspace = (rootBranch: string | null = "release/current-root") => {
    let rootStatusInvalidated = false;
    return WorktreeMcpService.layer.pipe(
      Layer.provideMerge(ThreadWorkspaceService.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Workspace return",
                workspaceRoot,
                scripts: [],
                defaultModelSelection: null,
                deletedAt: null,
                createdAt: "2026-10-13T00:00:00.000Z",
                updatedAt: "2026-10-13T00:00:00.000Z",
              } as Project),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            localStatus: (input) => {
              assert.equal(input.cwd, workspaceRoot);
              return Effect.succeed({
                isRepo: true,
                refName: rootStatusInvalidated ? rootBranch : "cached/old-root",
              } as never);
            },
            invalidateLocalStatus: (cwd) => {
              assert.equal(cwd, workspaceRoot);
              rootStatusInvalidated = true;
              return Effect.void;
            },
            listLocalBranchNames: () => Effect.succeed([]),
            createWorktree: () =>
              Effect.succeed({ worktree: { path: worktreePath, refName: "feature/new" } } as never),
            removeWorktree: () => Effect.void,
            deleteLocalBranch: () => Effect.void,
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" } as const),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: () => Effect.succeed({} as never),
          }),
          ServerSettings.layerTest(),
          NodeServices.layer,
        ),
      ),
    );
  };
  const scope = (threadId: ThreadId) => ({
    environmentId: EnvironmentId.make("workspace-return-environment"),
    requestNamespace: "workspace-return-session",
    capabilities: new Set(["worktree"] as const),
    thread: {
      threadId,
      providerSessionId: "workspace-return-session",
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    issuedAt: 1,
  });
  const create = (threadId: ThreadId, path: string | null) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* seedProject({
        projectId,
        title: "Workspace return",
        workspaceRoot,
        defaultModelSelection: null,
        createdAt: "2026-10-13T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title: "Workspace return",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: path === null ? "release/current-root" : "feature/old",
        worktreePath: path,
        createdBy: "user",
        creationSource: "web",
      });
      return orchestrator;
    });

  it.effect(
    "returns a live thread to root, queues continuation, and executes its detach after commit",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("workspace-return-live");
        const orchestrator = yield* create(threadId, worktreePath);
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("workspace-return-first"),
          threadId,
          messageId: MessageId.make("workspace-return-first"),
          text: "Work in the feature checkout.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs[0]!;
        const providerThread = initial.providerThreads[0]!;
        const now = yield* DateTime.now;
        const session = {
          id: providerThread.providerSessionId!,
          driver,
          providerInstanceId: modelSelection.instanceId,
          status: "running" as const,
          cwd: worktreePath,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("workspace-return-running"),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("workspace-return-session"),
              type: "provider-session.attached",
              threadId,
              occurredAt: now,
              payload: session,
            },
          ],
        });
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "Session seeded by test",
        });
        const detach = vi.spyOn(sessions, "detach").mockReturnValue(Effect.void);
        yield* Effect.addFinalizer(() => Effect.sync(() => detach.mockRestore()));
        const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const result = yield* workspace.returnToRoot(
          threadId,
          { continuationPrompt: "Continue coordinating from root." },
          { createdBy: "agent", creationSource: "mcp" },
        );
        assert.isNull(result.worktreePath);
        assert.equal(result.branch, "release/current-root");
        assert.deepEqual(result.continuation, { status: "scheduled", delivery: "queued" });
        const moved = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(moved.thread.worktreePath);
        assert.equal(moved.thread.branch, "release/current-root");
        assert.equal(moved.runs[1]?.status, "queued");
        assert.equal(moved.messages.at(-1)?.text, "Continue coordinating from root.");
        const worktrees = yield* WorktreeMcpService.WorktreeMcpService;
        const status = yield* worktrees.status(scope(threadId));
        assert.deepEqual(
          {
            attached: status.attached,
            worktreePath: status.worktreePath,
            branch: status.branch,
            root: status.projectWorkspaceRoot,
          },
          {
            attached: false,
            worktreePath: null,
            branch: "release/current-root",
            root: workspaceRoot,
          },
        );
        assert.equal(detach.mock.calls.length, 0);
        yield* worker.drain();
        assert.equal(detach.mock.calls.length, 1);
        assert.equal(detach.mock.calls[0]?.[0].providerSessionId, session.id);
      }).pipe(Effect.provide(layerWorkspace())),
  );

  it.effect.each(["release/current-root", null])(
    "moves an idle thread without continuation and rejects stale bindings (%s)",
    (rootBranch) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`workspace-return-idle:${rootBranch ?? "detached"}`);
        const orchestrator = yield* create(threadId, worktreePath);
        const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const result = yield* workspace.returnToRoot(
          threadId,
          {},
          { createdBy: "user", creationSource: "web" },
        );
        assert.equal(result.continuation.status, "skipped");
        const moved = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(moved.thread.worktreePath);
        assert.equal(moved.thread.branch, rootBranch);
        assert.equal(moved.messages.length, 0);
        assert.equal(
          (yield* workspace
            .returnToRoot(threadId, {}, { createdBy: "user", creationSource: "web" })
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        const stale = yield* workspace
          .bind({
            command: {
              type: "thread.metadata.update",
              commandId: CommandId.make("workspace-stale"),
              threadId,
              branch: "feature/stale",
              worktreePath,
              expectedWorktreePath: worktreePath,
            },
            continuationCommandId: CommandId.make("workspace-stale-continuation"),
            continuationMessageId: MessageId.make("workspace-stale-continuation"),
            projectId,
            provenance: { createdBy: "user", creationSource: "web" },
          })
          .pipe(Effect.exit);
        assert.equal(stale._tag, "Failure");
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.worktreePath);
      }).pipe(Effect.provide(layerWorkspace(rootBranch))),
  );

  it.effect.each(["preparing", "starting", "running", "waiting", "archived"] as const)(
    "refuses both handoff directions for %s without detaching live work",
    (state) =>
      Effect.gen(function* () {
        const workspace = yield* ThreadWorkspaceService.ThreadWorkspaceService;
        const handoff = yield* WorktreeMcpService.WorktreeMcpService;
        const sink = yield* EventSink.EventSinkV2;
        for (const direction of ["root", "worktree"] as const) {
          const threadId = ThreadId.make(`workspace-refusal:${direction}:${state}`);
          const orchestrator = yield* create(threadId, direction === "root" ? worktreePath : null);
          if (state === "archived") {
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make(`archive:${threadId}`),
              threadId,
            });
          } else {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`message:${threadId}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}`),
              text: "Unfinished work.",
              attachments: [],
              dispatchMode: { type: "defer_start" },
              createdBy: "user",
              creationSource: "web",
            });
            const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`run:${threadId}`),
                  type: "run.updated",
                  threadId,
                  runId: run.id,
                  occurredAt: yield* DateTime.now,
                  payload: { ...run, status: state },
                },
              ],
            });
          }
          const before = yield* orchestrator.getThreadProjection(threadId);
          const exit =
            direction === "root"
              ? yield* workspace
                  .returnToRoot(
                    threadId,
                    { continuationPrompt: "Must not queue." },
                    { createdBy: "agent", creationSource: "mcp" },
                  )
                  .pipe(Effect.exit)
              : yield* handoff
                  .handoff(scope(threadId), {
                    branch: "feature/new",
                    continuationPrompt: "Must not queue.",
                    startFromOrigin: false,
                    runSetupScript: false,
                  })
                  .pipe(Effect.exit);
          assert.equal(exit._tag, "Failure");
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(after.thread.worktreePath, before.thread.worktreePath);
          assert.equal(after.thread.branch, before.thread.branch);
          assert.equal(after.messages.length, before.messages.length);
          assert.equal(after.providerSessions.length, 0);
        }
      }).pipe(Effect.provide(layerWorkspace())),
  );
});

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const claudeSelection: ModelSelection = {
  instanceId: claudeInstanceId,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const claudeInstance: ProviderInstance = {
  ...providerInstance,
  instanceId: claudeInstanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: "claude:test",
  },
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: claudeInstanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
  },
};
const layerSwitchInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (id) =>
    Effect.succeed(
      [providerInstance, alternateProviderInstance, claudeInstance].find(
        (instance) => instance.instanceId === id,
      ),
    ),
  listInstances: Effect.succeed([providerInstance, alternateProviderInstance, claudeInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const makeUsageSwitchTest = (preferences: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectStore.layer,
    ProjectionStore.layer,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(IssueWorkStore.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provideMerge(ServerSettings.layerTest(preferences)),
    Layer.provide(layerSwitchInstances),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerProjectServiceTest),
    Layer.provide(layerPlatformTest),
  );
const layerUsageSwitchTest = makeUsageSwitchTest();
const switchSnapshots: readonly ServerProvider[] = [modelSelection, claudeSelection].map(
  (selection) => ({
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make(selection.instanceId),
    displayName: selection.instanceId,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T00:00:00Z",
    models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  }),
);

it.layer(layerUsageSwitchTest)("automatic usage-limit provider switch", (it) => {
  it.effect.each([
    "role",
    "no-role",
    "off",
    "wait",
    "unavailable",
    "unknown-reset",
    "restart",
    "user-race",
    "reactor",
    "claude-to-codex",
    "both-limited",
    "queued",
    "back-before-reset",
    "expired-no-target",
    "out-of-scope",
    "retired",
  ] as const)("recovers committed failures: %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`auto-switch:${scenario}`);
      const otherId = ThreadId.make(`auto-switch:${scenario}:other`);
      const projectId = ProjectId.make(`auto-switch:${scenario}:project`);
      const source =
        scenario === "claude-to-codex"
          ? { ...claudeSelection, options: [{ id: "effort", value: "low" }] }
          : modelSelection;
      const target: ModelSelection =
        scenario === "claude-to-codex" ? modelSelection : claudeSelection;
      const now = yield* DateTime.now;
      yield* seedProject({
        projectId,
        title: "Provider switch",
        workspaceRoot: process.cwd(),
        defaultModelSelection: source,
        createdAt: DateTime.formatIso(now),
      });
      for (const id of [threadId, otherId]) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${id}:create`),
          threadId: id,
          projectId,
          title: "Switch test",
          modelSelection: source,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${id}:start`),
          threadId: id,
          messageId: MessageId.make(`${id}:start`),
          text: "Finish the work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      if (scenario === "queued")
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:queued`),
          threadId,
          messageId: MessageId.make(`${threadId}:queued`),
          text: "Next task",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const original = initial.runs[0]!;
      const resetAt =
        scenario === "unknown-reset"
          ? null
          : DateTime.formatIso(
              DateTime.add(now, { hours: scenario === "expired-no-target" ? -1 : 1 }),
            );
      const role: ModelRole = {
        id: "implementor-thorough",
        role: "implementor",
        profile: "thorough",
        name: "Implementor",
        description: "",
        // The source need not match: persisted role must take precedence.
        targets: [
          {
            providerInstanceId: target.instanceId,
            model: target.model,
            ...(target.options === undefined ? {} : { options: target.options }),
          },
        ],
      };
      const settings = {
        usageLimitRecovery:
          scenario === "off"
            ? ("off" as const)
            : scenario === "wait"
              ? ("wait" as const)
              : ("switch" as const),
        // The role-less thread is an Orchestrator: keep that profile on its own provider so only
        // the scenario's fallback models offer a target.
        modelRoles:
          scenario === "role" || scenario === "reactor"
            ? [role]
            : [
                {
                  id: "orchestrator",
                  role: "orchestrator" as const,
                  name: "Orchestrator",
                  description: "",
                  targets: [{ providerInstanceId: source.instanceId, model: source.model }],
                },
              ],
        usageLimitFallbackModels:
          scenario === "unavailable" || scenario === "expired-no-target" ? [] : [target],
        dontAskMode: true,
        autoResumeLimitedThreads: scenario === "wait",
        snoozeLimitedThreads: scenario === "wait",
      };
      const workerLayer = Layer.merge(
        UsageLimitProviderSwitchWorker.layer,
        UsageLimitRecoveryWorker.serviceLayer,
      ).pipe(
        Layer.provide(ServerSettings.layerTest(settings)),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(
              scenario === "out-of-scope"
                ? switchSnapshots.map((provider) =>
                    provider.instanceId === source.instanceId
                      ? { ...provider, driver: ProviderDriverKind.make("cursor") }
                      : provider,
                  )
                : switchSnapshots,
            ),
          }),
        ),
        Layer.provide(
          ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
            Layer.provide(layerSwitchInstances),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* UsageLimitProviderSwitchWorker.UsageLimitProviderSwitchWorker;
        const resetWorker = yield* UsageLimitRecoveryWorker.UsageLimitRecoveryWorker;
        const afterSequence = yield* sink.latestSequence();
        const continued = yield* Deferred.make<void>();
        if (scenario === "reactor") {
          yield* sink.stream({ threadId, afterSequence }).pipe(
            Stream.runForEach(({ event }) =>
              event.type === "run.created" && event.payload.providerInstanceId === target.instanceId
                ? Deferred.succeed(continued, undefined)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* Layer.build(
            UsageLimitProviderSwitchWorker.workerLive.pipe(
              Layer.provide(Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void })),
            ),
          );
        }
        yield* sink.write({
          commandId: CommandId.make(`${threadId}:failure`),
          events: [
            ...(scenario === "role" || scenario === "reactor"
              ? [
                  {
                    id: EventId.make(`${threadId}:role`),
                    type: "thread.metadata-updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: { ...initial.thread, role: "implementor" as const },
                  },
                ]
              : []),
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status: "failed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: original.id,
                nodeId: original.rootNodeId,
                providerThreadId: original.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Usage limit",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Allowance used",
                  code: "usageLimitExceeded",
                  retryable: null,
                  ...(resetAt === null ? {} : { resetAt }),
                },
              },
            },
          ],
        });
        const otherBefore = yield* orchestrator.getThreadProjection(otherId);
        if (scenario === "user-race") {
          // A saved automatic command cannot override a later user-selected model.
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${threadId}:user-change`),
            threadId,
            modelSelection: { ...source, model: "user-selected" },
          });
          const raced = yield* orchestrator
            .dispatch({
              type: "provider.switch",
              commandId: CommandId.make(`${threadId}:stale-switch`),
              threadId,
              modelSelection: target,
              autoProviderSwitch: {
                runId: original.id,
                from: source,
                to: target,
                resetAt,
                message: "Automatic switch",
              },
            })
            .pipe(Effect.result);
          assert.equal(raced._tag, "Failure");
          yield* worker.recover(threadId);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection.model,
            "user-selected",
          );
          assert.isNull((yield* projections.getThreadShell(threadId))?.autoProviderSwitch ?? null);
          assert.lengthOf(
            yield* projections.getLimitRecoveryCandidates({
              now,
              autoResume: false,
              snooze: false,
              switchProvider: true,
              switchProviderInstanceIds: [source.instanceId],
            }),
            0,
          );
          return;
        }
        if (scenario === "retired") {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:retired`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...initial.thread,
                  repositoryOrchestration: {
                    host: "github.com",
                    repository: "owner/repo",
                    repositoryId: "repository",
                    projectId,
                    launchCommandId: CommandId.make("launch"),
                    revision: 1,
                    paused: false,
                    workerLimit: 4,
                    readOnlyLimit: 4,
                    publishStatusComments: false,
                    publishCloseoutComments: false,
                    milestones: [],
                    suspendedIssues: [],
                    retiredToThreadId: otherId,
                  },
                },
              },
            ],
          });
          assert.lengthOf(
            yield* projections.getLimitRecoveryCandidates({
              now,
              autoResume: true,
              snooze: true,
              switchProvider: true,
              switchProviderInstanceIds: [source.instanceId],
            }),
            0,
          );
          yield* worker.recover(threadId);
          assert.isUndefined(
            (yield* orchestrator.getThreadProjection(threadId)).thread.autoProviderSwitch,
          );
          return;
        }
        if (scenario === "restart") {
          yield* orchestrator.dispatch({
            type: "provider.switch",
            commandId: CommandId.make(`limit-switch:${threadId}:${original.id}`),
            threadId,
            modelSelection: target,
            autoProviderSwitch: {
              runId: original.id,
              from: source,
              to: target,
              resetAt,
              message: "Automatic switch",
            },
          });
        }
        if (scenario === "reactor") yield* Deferred.await(continued);
        else yield* worker.sweep;
        const changed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(yield* orchestrator.getThreadProjection(otherId), otherBefore);
        if (scenario === "off" || scenario === "wait" || scenario === "out-of-scope") {
          assert.deepEqual(changed.thread.modelSelection, source);
          assert.isNull(changed.thread.autoProviderSwitch ?? null);
          assert.equal(changed.runs.length, 1);
          yield* resetWorker.sweep;
          const armed = (yield* projections.getThreadShell(threadId))!;
          if (scenario === "off") assert.isNull(armed.limitRecovery ?? null);
          else {
            assert.isTrue(armed.limitRecovery?.autoResume);
            assert.isTrue(armed.limitRecovery?.snooze);
            yield* TestClock.adjust("1 hour");
            yield* resetWorker.sweep;
            assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 2);
          }
          return;
        }
        if (scenario === "expired-no-target") {
          assert.equal(changed.thread.autoProviderSwitch?.to, null);
          assert.isNull(changed.thread.limitRecovery ?? null);
          assert.lengthOf(
            yield* projections.getLimitRecoveryCandidates({
              now,
              autoResume: false,
              snooze: false,
              switchProvider: true,
              switchProviderInstanceIds: [source.instanceId],
            }),
            0,
          );
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          yield* worker.sweep;
          yield* resetWorker.sweep;
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          return;
        }
        if (scenario === "unavailable") {
          assert.deepEqual(changed.thread.modelSelection, source);
          assert.equal(changed.thread.autoProviderSwitch?.to, null);
          assert.include(changed.thread.autoProviderSwitch!.message, "No alternative");
          assert.isTrue(changed.thread.limitRecovery?.autoResume);
          assert.isTrue(changed.thread.limitRecovery?.snooze);
          yield* TestClock.adjust("1 hour");
          yield* resetWorker.sweep;
          assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 2);
          return;
        }
        assert.deepEqual(changed.thread.modelSelection, target);
        assert.deepEqual(changed.thread.autoProviderSwitch?.from, source);
        const continuation = changed.runs.find(
          (run) =>
            run.userMessageId === MessageId.make(`limit-switch-resume:${threadId}:${original.id}`),
        )!;
        assert.equal(changed.runs.length, scenario === "queued" ? 3 : 2);
        assert.equal(continuation.providerInstanceId, target.instanceId);
        if (scenario === "queued") {
          const queued = changed.runs.find((run) => run.status === "queued")!;
          assert.deepEqual(queued.modelSelection, target);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:continue-completed`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...continuation, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          const started = yield* orchestrator.getThreadProjection(threadId);
          const next = started.runs.find((run) => run.id === queued.id)!;
          assert.equal(next.status, "starting");
          assert.deepEqual(next.modelSelection, target);
          assert.deepEqual(started.thread.modelSelection, target);
          assert.equal(
            started.attempts.find((attempt) => attempt.id === next.activeAttemptId)
              ?.providerInstanceId,
            target.instanceId,
          );
          assert.equal(
            started.nodes.find((node) => node.id === next.rootNodeId)?.providerThreadId,
            next.providerThreadId,
          );
          return;
        }
        if (scenario === "back-before-reset") {
          const marker = changed.thread.autoProviderSwitch!;
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${threadId}:early-back`),
            threadId,
            modelSelection: marker.switchBack ?? marker.from,
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:continue-completed`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...continuation, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:retry`),
            threadId,
            messageId: MessageId.make(`${threadId}:retry`),
            text: "Try again",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const next = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          const error = changed.turnItems.find((item) => item.type === "error")!;
          if (error.type !== "error") return;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:retry-failed`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...next, status: "failed", completedAt: now },
              },
              {
                id: EventId.make(`${threadId}:retry-error`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...error,
                  id: TurnItemId.make(`${threadId}:retry-error`),
                  runId: next.id,
                  nodeId: next.rootNodeId,
                  providerThreadId: next.providerThreadId,
                },
              },
            ],
          });
          yield* worker.recover(threadId);
          const again = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(again.thread.modelSelection, target);
          assert.equal(again.thread.autoProviderSwitch?.runId, next.id);
          assert.deepEqual(again.thread.autoProviderSwitch?.switchBack, source);
          assert.equal(again.runs.length, 4);
          return;
        }
        assert.isTrue(
          changed.turnItems.some(
            (item) => item.type === "user_message" && item.text === "Continue where you left off.",
          ),
        );
        const handoffItem = changed.turnItems.find((item) => item.type === "handoff");
        assert.isDefined(handoffItem);
        if (handoffItem?.type === "handoff") {
          assert.include(handoffItem.fromProviderInstanceIds, source.instanceId);
          assert.equal(handoffItem.toProviderInstanceId, target.instanceId);
        }
        assert.isTrue(
          changed.turnItems.some(
            (item) =>
              item.type === "system_notice" &&
              item.message === changed.thread.autoProviderSwitch?.message,
          ),
        );
        const sequence = yield* orchestrator.getThreadEventSequence(threadId);
        const marker = changed.thread.autoProviderSwitch!;
        yield* orchestrator.dispatch({
          type: "provider.switch",
          commandId: CommandId.make(`limit-switch:${threadId}:${original.id}`),
          threadId,
          modelSelection: target,
          autoProviderSwitch: marker,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`limit-switch-resume:${threadId}:${original.id}`),
          messageId: MessageId.make(`limit-switch-resume:${threadId}:${original.id}`),
          threadId,
          automaticProviderContinuationOfRunId: original.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        });
        yield* worker.sweep;
        yield* worker.recover(threadId);
        assert.equal(
          yield* orchestrator.getThreadEventSequence(threadId),
          sequence,
          "replay must not switch or continue twice",
        );
        if (scenario === "both-limited") {
          const second = changed.runs[1]!;
          const error = changed.turnItems.find((item) => item.type === "error")!;
          if (error.type !== "error") return;
          yield* sink.write({
            commandId: CommandId.make(`${threadId}:second-failure`),
            events: [
              {
                id: EventId.make(`${threadId}:second-failed`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...second, status: "failed", completedAt: now },
              },
              {
                id: EventId.make(`${threadId}:second-error`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...error,
                  id: TurnItemId.make(`${threadId}:second-error`),
                  runId: second.id,
                  nodeId: second.rootNodeId,
                  providerThreadId: second.providerThreadId,
                },
              },
            ],
          });
          yield* worker.recover(threadId);
          const waiting = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(waiting.thread.modelSelection, target);
          assert.equal(waiting.thread.autoProviderSwitch?.to, null);
          assert.deepEqual(waiting.thread.autoProviderSwitch?.switchBack, source);
          assert.equal(
            waiting.runs.length,
            2,
            "both limited providers must wait instead of cycling",
          );
          return;
        }
        yield* TestClock.adjust("1 hour");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection,
          target,
          "reset must not switch back",
        );
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:switch-back`),
          threadId,
          modelSelection: marker.switchBack ?? marker.from,
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection,
          source,
        );
      }).pipe(Effect.provide(workerLayer));
    }),
  );
});
it.effect.each([
  "switch",
  "off",
  "wait",
  "wait-model",
  "no-target",
  "deadline",
  "starting-timeout",
  "off-during-hold",
  "restart",
  "managed-queued",
  "managed-held",
  "expired-snooze",
  "cancelled",
  "changed-model",
  "snoozed",
  "session-error",
] as const)("bounds a delegated child's usage-limit recovery: %s", (scenario) => {
  const mode = scenario === "off" ? "off" : scenario.startsWith("wait") ? "wait" : "switch";
  const preferences = {
    usageLimitRecovery: mode,
    autoResumeLimitedThreads: mode === "wait",
    snoozeLimitedThreads: mode === "wait",
    usageLimitFallbackModels: scenario === "no-target" ? [] : [claudeSelection],
    // The delegated child is an Implementor: keep its profiles on its own provider so they offer
    // no switch target either.
    ...(scenario === "no-target"
      ? {
          modelRoles: (["fast", "thorough"] as const).map((profile) => ({
            id: `implementor-${profile}`,
            role: "implementor" as const,
            profile,
            name: "Implementor",
            description: "",
            targets: [
              { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
            ],
          })),
        }
      : {}),
  } satisfies Parameters<typeof ServerSettings.layerTest>[0];
  const workers = Layer.merge(
    UsageLimitProviderSwitchWorker.layer,
    UsageLimitRecoveryWorker.serviceLayer,
  ).pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(switchSnapshots),
      }),
    ),
    Layer.provide(
      ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
        Layer.provide(layerSwitchInstances),
      ),
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const switchWorker = yield* UsageLimitProviderSwitchWorker.UsageLimitProviderSwitchWorker;
    const resetWorker = yield* UsageLimitRecoveryWorker.UsageLimitRecoveryWorker;
    const parentThreadId = ThreadId.make(`limit-child:${scenario}:parent`);
    const projectId = ProjectId.make(`limit-child:${scenario}:project`);
    const now = yield* DateTime.now;
    yield* seedProject({
      projectId,
      title: "Delegated recovery",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      createdAt: DateTime.formatIso(now),
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${parentThreadId}:create`),
      threadId: parentThreadId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${parentThreadId}:start`),
      threadId: parentThreadId,
      messageId: MessageId.make(`${parentThreadId}:start`),
      text: "Delegate the work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`${parentThreadId}:delegate`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Finish the implementation",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    const childThreadId = task.childThreadId!;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const original = child.runs[0]!;
    if (scenario === "managed-queued" || scenario === "managed-held" || scenario === "cancelled") {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${childThreadId}:queued`),
        threadId: childThreadId,
        messageId: MessageId.make(`${childThreadId}:queued`),
        text: "Queued issue work",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const queued = (yield* orchestrator.getThreadProjection(childThreadId)).runs.at(-1)!;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${childThreadId}:managed`),
            type: "thread.metadata-updated",
            threadId: childThreadId,
            occurredAt: now,
            payload: {
              ...child.thread,
              linkedIssue: {
                host: "github.com",
                repository: "owner/repo",
                repositoryId: "repo",
                id: "issue",
                nodeId: "issue-node",
                number: 14,
                url: "https://github.com/owner/repo/issues/14",
                title: "Managed work",
              },
            },
          },
          {
            id: EventId.make(`${childThreadId}:queue-held`),
            type: "run.updated",
            threadId: childThreadId,
            occurredAt: now,
            payload: { ...queued, queueHeld: true },
          },
        ],
      });
    }
    yield* sink.write({
      commandId: CommandId.make(`${childThreadId}:failure`),
      events: [
        {
          id: EventId.make(`${childThreadId}:failed`),
          type: "run.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...original, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`${childThreadId}:error`),
          type: "turn-item.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${childThreadId}:error`),
            type: "error",
            threadId: childThreadId,
            runId: original.id,
            nodeId: original.rootNodeId,
            providerThreadId: original.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Allowance used",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
            },
          },
        },
      ],
    });
    if (scenario === "expired-snooze" || scenario === "snoozed")
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${childThreadId}:snooze`),
            type: "thread.metadata-updated",
            threadId: childThreadId,
            occurredAt: now,
            payload: {
              ...child.thread,
              snoozedAt: now,
              snoozedUntil: DateTime.add(now, { minutes: scenario === "expired-snooze" ? -1 : 60 }),
            },
          },
        ],
      });
    if (scenario === "session-error")
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${childThreadId}:session-error`),
            type: "provider-session.attached",
            threadId: childThreadId,
            occurredAt: now,
            payload: {
              id: child.providerThreads[0]!.providerSessionId!,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "error",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: "Authentication expired",
            },
          },
        ],
      });
    yield* orchestrator.recoverDelegatedTasks;
    const assertFailed = Effect.gen(function* () {
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(parent.subagents[0]!.status, "failed");
      assert.include(parent.subagents[0]!.result ?? "", "Allowance used");
      assert.lengthOf(
        parent.contextTransfers.filter(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
        ),
        1,
      );
      assert.isTrue(yield* (yield* IssueWorkStore.IssueWorkStore).resultAvailable(childThreadId));
    });
    if (
      mode === "off" ||
      mode === "wait" ||
      scenario === "snoozed" ||
      scenario === "session-error"
    ) {
      yield* assertFailed;
      if (mode === "wait") {
        yield* resetWorker.sweep;
        if (scenario === "wait-model")
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${childThreadId}:model-change`),
            threadId: childThreadId,
            modelSelection: { ...modelSelection, model: "gpt-5.4-other" },
          });
        yield* TestClock.adjust("1 hour");
        yield* resetWorker.sweep;
        const resumed = yield* orchestrator.getThreadProjection(childThreadId);
        assert.lengthOf(resumed.runs, 2);
        assert.notEqual(
          resumed.runs[1]!.delegatedTaskId,
          task.id,
          "Wait resume is ordinary follow-up work",
        );
        if (scenario === "wait-model")
          assert.equal(resumed.runs[1]!.modelSelection.model, "gpt-5.4-other");
        yield* assertFailed;
      }
      yield* switchWorker.sweep;
      yield* assertFailed;
      return;
    }
    assert.isNull((yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.result);
    assert.isTrue(yield* orchestrator.delegatedTaskResultPending(childThreadId, task.id));
    if (scenario === "restart" || scenario === "changed-model" || scenario === "off-during-hold") {
      yield* orchestrator.dispatch({
        type: "provider.switch",
        commandId: CommandId.make(`${childThreadId}:persisted-switch`),
        threadId: childThreadId,
        modelSelection: claudeSelection,
        autoProviderSwitch: {
          runId: original.id,
          from: modelSelection,
          to: claudeSelection,
          resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
          message: "Automatic switch",
        },
      });
      if (scenario === "changed-model")
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${childThreadId}:changed-model`),
          threadId: childThreadId,
          modelSelection: { ...claudeSelection, model: "different-model" },
        });
    } else if (scenario !== "deadline") yield* switchWorker.recover(childThreadId);
    if (scenario === "off-during-hold") {
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        usageLimitRecovery: "off",
      });
      yield* switchWorker.sweep;
      assert.isNull(
        (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.result,
        "Off does no per-tick child recovery",
      );
      yield* orchestrator.recoverDelegatedTask(childThreadId, original.id);
      yield* assertFailed;
      return;
    }
    if (scenario === "no-target") {
      yield* assertFailed;
      return;
    }
    if (scenario === "changed-model") {
      yield* switchWorker.sweep;
      yield* assertFailed;
      return;
    }
    if (scenario === "managed-queued" || scenario === "managed-held" || scenario === "cancelled") {
      const queued = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
        (run) => run.delegatedTaskId === task.id,
      )!;
      assert.equal(queued.status, "queued");
      if (scenario === "managed-held" || scenario === "cancelled")
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${childThreadId}:continuation-held`),
              type: "run.updated",
              threadId: childThreadId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true },
            },
          ],
        });
      const sequence = yield* orchestrator.getThreadEventSequence(childThreadId);
      yield* switchWorker.recover(childThreadId);
      yield* switchWorker.sweep;
      assert.equal(
        yield* orchestrator.getThreadEventSequence(childThreadId),
        sequence,
        "a persisted queued continuation is never re-sent",
      );
      if (scenario === "cancelled") {
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`${childThreadId}:cancel-continuation`),
          threadId: childThreadId,
          runId: queued.id,
        });
        yield* switchWorker.sweep;
        yield* assertFailed;
        return;
      }
    }
    if (
      scenario === "deadline" ||
      scenario === "starting-timeout" ||
      scenario === "restart" ||
      scenario === "managed-queued" ||
      scenario === "managed-held"
    ) {
      yield* TestClock.adjust(USAGE_LIMIT_SWITCH_HOLD_MS - 1);
      yield* orchestrator.recoverDelegatedTasks;
      assert.isNull((yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.result);
      yield* TestClock.adjust(1);
      // Rebuild the worker against the same persisted database: no in-memory deadline survives.
      yield* Effect.gen(function* () {
        yield* (yield* UsageLimitProviderSwitchWorker.UsageLimitProviderSwitchWorker).sweep;
      }).pipe(Effect.provide(workers));
      yield* assertFailed;
      const released = yield* orchestrator.getThreadProjection(childThreadId);
      const automatic = released.runs.find(
        (run) =>
          run.userMessageId ===
          MessageId.make(`limit-switch-resume:${childThreadId}:${original.id}`),
      );
      if (scenario === "starting-timeout") assert.equal(automatic?.status, "interrupted");
      else if (scenario === "managed-queued" || scenario === "managed-held")
        assert.equal(automatic?.status, "cancelled");
      else
        assert.isUndefined(automatic, "a released failure must not dispatch a late continuation");
      assert.lengthOf(
        yield* (yield* ProjectionStore.ProjectionStoreV2).getRecentUsageLimitChildren(
          yield* DateTime.now,
        ),
        0,
        "delivered children leave the bounded query",
      );
      const attempted = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${childThreadId}:late-continuation`),
          threadId: childThreadId,
          messageId: MessageId.make(`${childThreadId}:late-continuation`),
          automaticProviderContinuationOfRunId: original.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.result);
      assert.equal(attempted._tag, "Failure");
      yield* switchWorker.recover(childThreadId);
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs,
        released.runs.length,
      );
      const after = yield* orchestrator.getThreadEventSequence(childThreadId);
      yield* switchWorker.sweep;
      yield* assertFailed;
      assert.equal(yield* orchestrator.getThreadEventSequence(childThreadId), after);
      return;
    }
    const resumed = yield* orchestrator.getThreadProjection(childThreadId);
    const continuation = resumed.runs.findLast(
      (run) => run.id !== original.id && run.delegatedTaskId === task.id,
    )!;
    assert.equal(continuation.delegatedTaskId, task.id);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${childThreadId}:continuation-running`),
          type: "run.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...continuation, status: "running", startedAt: now },
        },
      ],
    });
    assert.isNull((yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.result);
    // Starting the continuation takes ownership even when its work exceeds the switch deadline.
    yield* TestClock.adjust(USAGE_LIMIT_SWITCH_HOLD_MS);
    yield* switchWorker.sweep;
    assert.isNull((yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.result);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    assert.include(
      (yield* projectionStore.getRecentUsageLimitChildren(yield* DateTime.now)).map(
        (candidate) => candidate.threadId,
      ),
      childThreadId,
    );
    yield* TestClock.adjust("31 seconds");
    assert.lengthOf(
      yield* projectionStore.getRecentUsageLimitChildren(yield* DateTime.now),
      0,
      "old failures are outside the indexed window",
    );
    const completedAt = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make(`${childThreadId}:success`),
      events: [
        {
          id: EventId.make(`${childThreadId}:completed`),
          type: "run.updated",
          threadId: childThreadId,
          occurredAt: completedAt,
          payload: { ...continuation, status: "completed", startedAt: now, completedAt },
        },
        {
          id: EventId.make(`${childThreadId}:answer`),
          type: "message.updated",
          threadId: childThreadId,
          occurredAt: completedAt,
          payload: {
            ...resumed.messages[0]!,
            id: MessageId.make(`${childThreadId}:answer`),
            runId: continuation.id,
            nodeId: continuation.rootNodeId,
            role: "assistant",
            text: "Recovered task result",
            streaming: false,
            updatedAt: completedAt,
          },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTasks;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(parent.subagents.length, 1);
    assert.equal(parent.subagents[0]!.status, "completed");
    assert.include(parent.subagents[0]!.result ?? "", "Recovered task result");
    const transfers = parent.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
    );
    assert.lengthOf(transfers, 1);
    yield* orchestrator.recoverDelegatedTasks;
    yield* switchWorker.sweep;
    yield* resetWorker.sweep;
    assert.lengthOf(
      (yield* orchestrator.getThreadProjection(parentThreadId)).contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
      ),
      1,
    );
  }).pipe(Effect.provide(workers.pipe(Layer.provideMerge(makeUsageSwitchTest(preferences)))));
});
