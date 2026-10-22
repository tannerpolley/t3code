import * as Context from "effect/Context";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { vi } from "@effect/vitest";
import {
  CommandId,
  IssueWorkCancelled,
  IssueWorkRequested,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");

const otherProjectId = ProjectId.make("project:launch-other");

const decodeIssueRequest = Schema.decodeEffect(Schema.fromJsonString(IssueWorkRequested));

const decodeIssueCancellation = Schema.decodeEffect(Schema.fromJsonString(IssueWorkCancelled));

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly projectRepositoryIdentity?: import("@t3tools/contracts").RepositoryIdentity;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly localStatus?: GitWorkflow.GitWorkflowService["Service"]["localStatus"];
  readonly invalidateLocalStatus?: GitWorkflow.GitWorkflowService["Service"]["invalidateLocalStatus"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly issueServiceLayer?: Layer.Layer<IssueService.IssueService>;
  readonly runContinuationWorker?: boolean;
  readonly continuationRequests?: Context.Service.Shape<
    typeof ProviderContinuationRequests.ProviderContinuationRequests
  >;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      runContinuationWorker: options.runContinuationWorker ?? false,
      ...(options.issueServiceLayer === undefined
        ? {}
        : { issueServiceLayer: options.issueServiceLayer }),
    },
  ).pipe(
    Layer.provide(
      options.continuationRequests === undefined
        ? Layer.empty
        : Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            options.continuationRequests,
          ),
    ),
  );
  const layerServerSettings = ServerSettings.layerTest({
    ...options.serverSettings,
    providerInstances: {
      ...Object.fromEntries(
        (options.adapters ?? [adapter]).map((provider) => [
          provider.instanceId,
          { driver: provider.driver, enabled: true, config: {} },
        ]),
      ),
      ...options.serverSettings?.providerInstances,
    },
  });
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(ProjectionStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provide(IssueWorkStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const localStatus = vi.fn(
    options.localStatus ?? (() => Effect.die("unexpected checkout status read")),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(
                options.projectRepositoryIdentity === undefined
                  ? project
                  : { ...project, repositoryIdentity: options.projectRepositoryIdentity },
              )
            : id === otherProjectId
              ? Option.some(
                  options.projectRepositoryIdentity === undefined
                    ? otherProject
                    : { ...otherProject, repositoryIdentity: options.projectRepositoryIdentity },
                )
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () =>
        Effect.succeed(
          [project, otherProject].map((entry) => ({
            ...entry,
            repositoryIdentity: options.projectRepositoryIdentity ?? entry.repositoryIdentity,
          })),
        ),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      resolveDefaultBranchRef: () => Effect.succeed("main"),
      renameBranch,
      localStatus,
      invalidateLocalStatus: options.invalidateLocalStatus ?? (() => Effect.void),
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeed(Option.none()),
      }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreadManagement, layerProjectedProjects, layerExternalServices),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerOrchestrator,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
      layerReceipts,
    ),
    createWorktree,
    removeWorktree,
    renameBranch,
    localStatus,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function suspensionWorkerLayer(
  dependencies: ReturnType<typeof makeHarness>["layer"],
  failInterrupt?: (threadId: ThreadId) => boolean,
) {
  const realExecutor = Layer.fresh(EffectWorker.layerExecutor).pipe(
    Layer.provide(
      Layer.mergeAll(
        dependencies,
        IdAllocator.layer,
        ProjectionStore.layer.pipe(Layer.provide(dependencies)),
        Layer.mock(RunFinalizationService.RunFinalizationService)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
        Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
      ),
    ),
  );
  const executor = Layer.effect(
    EffectWorker.OrchestrationEffectExecutorV2,
    Effect.gen(function* () {
      const real = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect, options) =>
          effect.request.type === "issue.suspension.interrupt" && failInterrupt?.(effect.threadId)
            ? Effect.fail(
                new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: "Injected interrupt failure",
                }),
              )
            : effect.request.type.startsWith("issue.suspension.")
              ? real.execute(effect, options)
              : Effect.void,
      });
    }),
  ).pipe(Layer.provide(realExecutor));
  return EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
    Layer.provide(Layer.mergeAll(dependencies, executor)),
  );
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

const reviewIssue = (number: number, repository = "tannerpolley/t3code") => ({
  host: "github.com",
  repository,
  repositoryId: `review-repo:${repository}`,
  id: `review-issue:${repository}:${number}`,
  nodeId: `node:${repository}:${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${repository}/issues/${number}`,
});

const reviewRead = (issue: ReturnType<typeof reviewIssue>) => ({
  issue,
  state: "open" as const,
  milestoneNumber: 1,
  parent: null,
  subIssues: [],
  blockedBy: [],
  parentComplete: true,
  subIssuesComplete: true,
  blockersComplete: true,
});

function reviewHarness(
  workRead: IssueService.IssueService["Service"]["workRead"],
  unsupportedRole = false,
  failInterrupt?: (threadId: ThreadId) => boolean,
) {
  const openCode = {
    ...adapter,
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
  };
  const claude = {
    ...adapter,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
  };
  const providers = [adapter, openCode, claude].map((entry): ServerProvider => ({
    instanceId: entry.instanceId,
    driver: entry.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  }));
  const reads = Layer.mock(IssueService.IssueService)({
    workRead,
    resolveLinkedIssue: (input) => Effect.succeed(reviewIssue(input.number, input.repository)),
    detail: (input) =>
      Effect.succeed({
        repository: { host: input.host ?? "github.com", repository: input.repository },
        viewer: null,
        fetchedAt: "2026-10-05T00:00:00Z",
        body: "Finish issue",
        comments: [],
        linkedPullRequests: [],
        issue: {
          number: input.number,
          title: `Issue ${input.number}`,
          url: reviewIssue(input.number, input.repository).url,
          state: "open",
          stateReason: null,
          author: null,
          assignees: [],
          labels: [],
          milestone: null,
          createdAt: "2026-10-05T00:00:00Z",
          updatedAt: "2026-10-05T00:00:00Z",
          commentCount: 0,
        },
      }),
    milestoneIssues: () => Effect.succeed({ issues: [], complete: true }),
  });
  const harness = makeHarness({
    adapters: [adapter, openCode, claude],
    providers,
    issueServiceLayer: reads,
    projectRepositoryIdentity: {
      canonicalKey: "github.com/tannerpolley/t3code",
      provider: "github",
      owner: "tannerpolley",
      name: "t3code",
      displayName: "tannerpolley/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/tannerpolley/t3code.git",
      },
    },
    serverSettings: {
      modelRoles: [
        {
          id: "worker",
          name: "Worker",
          description: "Issue worker",
          targets: [
            {
              providerInstanceId: unsupportedRole ? openCode.instanceId : adapter.instanceId,
              model: "test-model",
            },
          ],
        },
      ],
    },
  });
  const dependencies = Layer.mergeAll(
    harness.layer,
    reads,
    IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
    IdAllocator.layer,
    ProviderAdapterRegistry.layerFromAdapters([adapter, openCode, claude]),
  );
  return {
    ...harness,
    dependencies,
    layer: Layer.mergeAll(
      IssueWorkService.layer.pipe(Layer.provide(dependencies)),
      suspensionWorkerLayer(dependencies, failInterrupt),
    ).pipe(Layer.provideMerge(dependencies)),
  };
}

const createReviewRoot = Effect.fn("test.createReviewRoot")(function* (
  repository = "tannerpolley/t3code",
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const issue = reviewIssue(1, repository);
  const rootId = ThreadId.make(`review-root:${repository}`);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`review-create:${repository}`),
    threadId: rootId,
    projectId,
    title: "Repository orchestrator",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    repositoryOrchestration: {
      host: issue.host,
      repository,
      repositoryId: issue.repositoryId,
      projectId,

      launchCommandId: CommandId.make(`review-create:${repository}`),
      revision: 1,
      paused: false,
      workerLimit: 4,
      readOnlyLimit: 4,
      publishStatusComments: false,
      publishCloseoutComments: false,
      milestones: [
        {
          number: 1,
          modelRoleId: "worker",

          status: "running",
          fingerprint: "",
        },
      ],
      suspendedIssues: [],
    },
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`review-start:${repository}`),
    threadId: rootId,
    messageId: MessageId.make(`review-start:${repository}`),
    text: "Start issue work",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return rootId;
});

const delegateReviewIssue = Effect.fn("test.delegateReviewIssue")(function* (
  parentId: ThreadId,
  issue: ReturnType<typeof reviewIssue>,
  key: string,
  selection: import("@t3tools/contracts").ModelSelection = modelSelection,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const parent = yield* threads.getThreadRecords(parentId, ["runs"]);
  const run = parent.runs.findLast((candidate) =>
    ["starting", "running", "waiting"].includes(candidate.status),
  )!;
  return yield* threads.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(key),
    parentThreadId: parentId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    issue,
    task: "Finish issue",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
});
export {
  adapter,
  createReviewRoot,
  decodeIssueCancellation,
  decodeIssueRequest,
  delegateReviewIssue,
  launchInput,
  makeHarness,
  modelSelection,
  otherProjectId,
  project,
  projectId,
  reviewHarness,
  reviewIssue,
  reviewRead,
  suspensionWorkerLayer,
};
