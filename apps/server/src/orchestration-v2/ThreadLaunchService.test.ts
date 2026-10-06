import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import { RuntimeRequestId, type OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import * as EventSink from "./EventSink.ts";
import { EventId } from "@t3tools/contracts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ChatAttachmentId,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  ProviderAdapterCapabilitiesError,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
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
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapterV2Shape;

interface HarnessOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterV2Shape>;
  readonly projectRepositoryIdentity?: import("@t3tools/contracts").RepositoryIdentity;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly localStatus?: GitWorkflow.GitWorkflowService["Service"]["localStatus"];
  readonly invalidateLocalStatus?: GitWorkflow.GitWorkflowService["Service"]["invalidateLocalStatus"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly issueServiceLayer?: Layer.Layer<IssueService.IssueService>;
  readonly runContinuationWorker?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer(options.adapters ?? [adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-launch" },
    registry,
    {
      databaseLayer: database,
      runEffectWorker: false,
      runContinuationWorker: options.runContinuationWorker ?? false,
      ...(options.issueServiceLayer === undefined
        ? {}
        : { issueServiceLayer: options.issueServiceLayer }),
    },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
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
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const externalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
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
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      localStatus,
      invalidateLocalStatus: options.invalidateLocalStatus ?? (() => Effect.void),
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    ServerSettings.layerTest(options.serverSettings),
    makeProviderRegistryLayer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: () => Effect.succeed(Option.none()),
      }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threadManagement, receipts, IdAllocator.layer)),
  );
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
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
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(Layer.mergeAll(threadManagement, projectedProjects, externalServices)),
  );
  return {
    layer: Layer.mergeAll(
      launch,
      orchestrator,
      threadManagement,
      titleRegeneration,
      outbox,
      database,
      externalServices,
    ),
    createWorktree,
    removeWorktree,
    renameBranch,
    localStatus,
    generateBranchName,
    generateThreadTitle,
    runSetup,
  };
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

function waitUntil<E, R>(predicate: () => Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* predicate()) return;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
    }
    assert.fail("Condition was not reached before timeout.");
  });
}

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const scheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(Layer.mergeAll(harness.layer, NodeCrypto.layer, Scheduler.layer)),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "succeeded");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      const projection = yield* threads.getThreadProjection(thread!.id);
      // Encoding the persisted projection exercises both message and turn-item wire schemas.
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find((item) => item.type === "user_message");
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, scheduledTasks)));
  },
);

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("returns a visible preparing message while provisioning is still blocked", () =>
  Effect.gen(function* () {
    const worktreeEntered = yield* Deferred.make<void>();
    const allowWorktree = yield* Deferred.make<void>();
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: () =>
        Deferred.succeed(worktreeEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowWorktree)),
          Effect.as({
            worktree: { path: "/repo-worktrees/feature", refName: "feature", headSha: "abc" },
          } as never),
        ),
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:blocked",
        thread: "thread:launch:blocked",
        message: "Build the feature",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      assert.equal(launched.projection.messages[0]?.text, "Build the feature");
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      assert.equal(
        launched.projection.turnItems.find((item) => item.type === "command_execution")?.status,
        "running",
      );
      yield* Deferred.await(worktreeEntered);
      let current = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(
        current.turnItems.find((item) => item.type === "command_execution")?.title,
        "Preparing worktree",
      );
      yield* Deferred.succeed(allowWorktree, undefined);
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      if (Option.isNone(entered)) {
        current = yield* threads.getThreadProjection(launched.threadId);
        assert.fail(
          `Setup was not reached; run=${current.runs[0]?.status ?? "missing"}, worklog=${current.turnItems.find((item) => item.type === "command_execution")?.title ?? "missing"}.`,
        );
      }
      current = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(
        current.turnItems.find((item) => item.type === "command_execution")?.title,
        "Starting setup script",
      );
      const prematureEffects = yield* outbox.listByCommandId(
        CommandId.make("command:launch:blocked:initial-message"),
      );
      assert.isEmpty(prematureEffects);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("provisions independent launches concurrently instead of behind a global semaphore", () =>
  Effect.gen(function* () {
    const setupCount = yield* Ref.make(0);
    const bothEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
          ),
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const results = yield* Effect.all(
        [
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-a",
              thread: "thread:launch:concurrent-a",
              message: "First",
            }),
          ),
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-b",
              thread: "thread:launch:concurrent-b",
              message: "Second",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result.projection.runs[0]?.status),
        ["preparing", "preparing"],
      );
      yield* Deferred.await(bothEntered);
      assert.equal(yield* Ref.get(setupCount), 2);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("enqueues provider work only after setup has been initiated", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({
            status: "started" as const,
            async: false,
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "vp install",
            terminalId: "setup",
            cwd: "/repo",
          }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:release",
        thread: "thread:launch:release",
        message: "Start after setup",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(setupEntered);
      assert.isEmpty(
        yield* outbox.listByCommandId(CommandId.make("command:launch:release:release")),
      );
      yield* Deferred.succeed(allowSetup, undefined);
      yield* waitUntil(() =>
        outbox
          .listByCommandId(CommandId.make("command:launch:release:release"))
          .pipe(Effect.map((effects) => effects.length === 1)),
      );
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.equal(projection.checkpointScopes[0]?.cwd, "/repo-worktrees/feature");
      assert.equal(
        projection.turnItems.find((item) => item.type === "command_execution")?.status,
        "completed",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "queues follow-up messages behind preparation and checkpoints them in the final workspace",
  () =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const failSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        runSetup: () =>
          Deferred.succeed(setupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(failSetup)),
            Effect.andThen(Effect.fail(new Error("setup failed") as never)),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:queued-during-preparation",
            thread: "thread:launch:queued-during-preparation",
            message: "Prepare the workspace",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        yield* Deferred.await(setupEntered);

        const followUp = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make("command:launch:queued-follow-up"),
          threadId: launched.threadId,
          messageId: MessageId.make("message:launch:queued-follow-up"),
          text: "Run after preparation",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(followUp.delivery, "queued");
        assert.equal(followUp.run.status, "queued");
        assert.equal(
          (yield* threads.getThreadRecords(launched.threadId, ["nodes"])).nodes.find(
            (node) => node.runId === followUp.run.id && node.kind === "root_turn",
          )?.checkpointScopeId,
          null,
        );

        yield* Deferred.succeed(failSetup, undefined);
        yield* waitUntil(() =>
          threads
            .getThreadProjection(launched.threadId)
            .pipe(
              Effect.map(
                (projection) =>
                  projection.runs.find((run) => run.id === followUp.run.id)?.status === "starting",
              ),
            ),
        );

        const projection = yield* threads.getThreadProjection(launched.threadId);
        const rootNode = projection.nodes.find(
          (node) => node.runId === followUp.run.id && node.kind === "root_turn",
        );
        assert.isNotNull(rootNode?.checkpointScopeId);
        assert.equal(
          projection.checkpointScopes.find((scope) => scope.id === rootNode?.checkpointScopeId)
            ?.cwd,
          "/repo-worktrees/feature",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each([" /COMPACT ", "/logout"])(
  "uses the first conversation message for a title after %s",
  (nativeCommand) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "compact-title",
            thread: "compact-title-thread",
            message: nativeCommand,
          }),
          generateTitle: true,
        });
        assert.isUndefined(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration,
        );
        assert.isFalse(
          (yield* outbox.listByCommandId(CommandId.make("compact-title:initial-message"))).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        const commandId = CommandId.make("compact-title-conversation");
        const messageId = MessageId.make("compact-title-conversation-message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId,
          createdBy: "user",
          creationSource: "web",
          text: "Fix the failing parser",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        assert.equal(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration
            ?.requestId,
          commandId,
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(commandId))
            .filter((effect) => effect.request.type === "thread-title.generate")
            .map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "initial", messageId } }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps native maintenance commands out of steering and restart messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const scenario of [
        {
          name: "compact-steer",
          first: "Fix the parser",
          next: " /COMPACT ",
          mode: "steer_active",
        },
        {
          name: "compact-restart",
          first: "Fix the parser",
          next: "/compact",
          mode: "restart_active",
        },
        {
          name: "logout-steer",
          first: "Fix the parser",
          next: "/logout",
          mode: "steer_active",
        },
        {
          name: "logout-restart",
          first: "Fix the parser",
          next: "/logout",
          mode: "restart_active",
        },
        {
          name: "steer-logout",
          first: "/logout",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "steer-compaction",
          first: "/compact",
          next: "Continue with the parser",
          mode: "steer_active",
        },
      ] as const) {
        const launched = yield* launches.launch(
          launchInput({
            command: `${scenario.name}:launch`,
            thread: scenario.name,
            message: scenario.first,
          }),
        );
        const before = yield* threads.getThreadProjection(launched.threadId);
        const targetRun = before.runs[0];
        if (targetRun === undefined) return yield* Effect.die("Launch must create a run");
        const commandId = CommandId.make(`${scenario.name}:message`);
        const failure = yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId,
            threadId: launched.threadId,
            messageId: MessageId.make(`${scenario.name}:message`),
            createdBy: "user",
            creationSource: "web",
            text: scenario.next,
            attachments: [],
            dispatchMode: { type: scenario.mode, targetRunId: targetRun.id },
          })
          .pipe(Effect.flip);
        assert.include(
          String(failure.cause).toLowerCase(),
          scenario.name.includes("logout") ? "sign" : "context compaction",
        );
        const after = yield* threads.getThreadProjection(launched.threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.thread.titleRegeneration, before.thread.titleRegeneration);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("arms durable title generation after accepting the first message", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      generateTitle: (input) =>
        Effect.succeed({
          title: input.previousTitle === undefined ? "Generated title" : "Regenerated title",
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const input = {
        ...launchInput({
          command: "command:launch:title-generation",
          thread: "thread:launch:title-generation",
          message: "Generate my title",
        }),
        title: "Generate my title",
        generateTitle: true,
      };
      const launched = yield* launches.launch(input);
      const generationCommandId = CommandId.make("command:launch:title-generation:initial-message");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.title, "Generate my title");
      assert.equal(projection.thread.titleRegeneration?.requestId, generationCommandId);
      assert.deepEqual(
        (yield* outbox.listByCommandId(generationCommandId)).map((effect) => effect.request),
        [
          {
            type: "thread-title.generate",
            kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
          },
        ],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: generationCommandId,
        kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
      });
      const generated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(generated.thread.title, "Generated title");
      assert.deepEqual(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );

      const manualRequestId = CommandId.make("command:title-generation:manual");
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: manualRequestId,
        threadId: launched.threadId,
        regenerateTitle: true,
      });
      assert.deepEqual(
        (yield* outbox.listByCommandId(manualRequestId)).map((effect) => effect.request),
        [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: manualRequestId,
        kind: { type: "regenerate" },
      });
      const regenerated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(regenerated.thread.title, "Regenerated title");
      assert.equal(
        harness.generateThreadTitle.mock.calls[1]?.[0]?.previousTitle,
        "Generated title",
      );

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:title-generation:user-rename"),
        threadId: launched.threadId,
        title: "Keep my title",
      });
      const renamed = yield* threads.getThreadProjection(launched.threadId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* threads.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("command:title-generation:stale-completion"),
        threadId: launched.threadId,
        requestId: generationCommandId,
        title: "Stale generated title",
      });
      const afterStaleCompletion = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(afterStaleCompletion.thread.title, "Keep my title");
      assert.equal(
        DateTime.toEpochMillis(afterStaleCompletion.thread.updatedAt),
        DateTime.toEpochMillis(renamed.thread.updatedAt),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not update a reused thread title when the initial message is rejected", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("generates an initial title for an attachment-only message", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const messageId = MessageId.make("message:image-only");
      const input = {
        ...launchInput({
          command: "command:launch:image-only",
          thread: "thread:launch:image-only",
        }),
        title: "Image: screenshot.png",
        generateTitle: true,
        initialMessage: {
          messageId,
          text: "",
          attachments: [
            {
              type: "image" as const,
              id: "attachment-image-only",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
          ],
        },
      };

      const launched = yield* launches.launch(input);
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: CommandId.make("command:launch:image-only:initial-message"),
        kind: { type: "initial", messageId },
      });

      assert.equal(harness.generateThreadTitle.mock.calls[0]?.[0]?.message, "");
      assert.equal(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.attachments?.[0]?.name,
        "screenshot.png",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("uses the available source control writer for generated worktree branches", () =>
  Effect.gen(function* () {
    const writerInstanceId = ProviderInstanceId.make("source-control-writer");
    const writerModelSelection = {
      instanceId: writerInstanceId,
      model: "branch-writer-model",
    } as const;
    const harness = makeHarness({
      serverSettings: {
        providerInstances: {
          [writerInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: {},
          },
        },
        sourceControlWriterModelSelection: writerModelSelection,
      },
      providers: [
        {
          instanceId: writerInstanceId,
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-07-28T00:00:00.000Z",
          availability: "available",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ],
    });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:source-control-writer",
          thread: "thread:launch:source-control-writer",
          message: "Generate a branch with the configured writer",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.deepEqual(
        harness.generateBranchName.mock.calls[0]?.[0]?.modelSelection,
        writerModelSelection,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("falls back when the source control writer is unavailable", () =>
  Effect.gen(function* () {
    const writerInstanceId = ProviderInstanceId.make("missing-source-control-writer");
    const harness = makeHarness({
      serverSettings: {
        providerInstances: {
          [writerInstanceId]: {
            driver: ProviderDriverKind.make("missing-driver"),
            config: {},
          },
        },
        sourceControlWriterModelSelection: {
          instanceId: writerInstanceId,
          model: "missing-branch-writer-model",
        },
      },
      providers: [],
    });

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:source-control-writer-fallback",
          thread: "thread:launch:source-control-writer-fallback",
          message: "Generate a branch with the available writer",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.deepEqual(
        harness.generateBranchName.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("runs a Scratch thread launched at the root in its own folder", () =>
  Effect.gen(function* () {
    // Only `projectId` stands in for the Scratch project here.
    const claimed: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
    const harness = makeHarness({
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: (input) =>
          Effect.sync(() => {
            if (input.projectId !== projectId) return Option.none();
            claimed.push({ threadId: input.threadId, text: input.text });
            return Option.some(`/scratch/folder-${claimed.length}`);
          }),
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:scratch",
        thread: "thread:launch:scratch",
        message: "Convert these PNGs",
      });
      const launched = yield* launches.launch(input);
      assert.deepEqual(claimed, [{ threadId: launched.threadId, text: "Convert these PNGs" }]);
      assert.equal(launched.projection.thread.worktreePath, "/scratch/folder-1");
      yield* waitUntil(() => Effect.sync(() => harness.runSetup.mock.calls.length === 1));
      assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
      assert.equal(harness.createWorktree.mock.calls.length, 0);

      // A retry replays the first attempt and claims no second folder.
      const retried = yield* launches.launch(input);
      assert.isTrue(retried.resumed);
      assert.lengthOf(claimed, 1);
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath,
        "/scratch/folder-1",
      );

      const other = yield* launches.launch({
        ...launchInput({
          command: "command:launch:scratch-other",
          thread: "thread:launch:scratch-other",
          message: "Elsewhere",
        }),
        projectId: otherProjectId,
      });
      assert.lengthOf(claimed, 1);
      assert.isNull(other.projection.thread.worktreePath);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("names the worktree itself when the client provides no branch", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:server-named-branch",
          thread: "thread:launch:server-named-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.createWorktree.mock.calls.length === 1));
      assert.match(
        harness.createWorktree.mock.calls[0]?.[0]?.newRefName ?? "",
        /^t3code\/[0-9a-f]{8}$/u,
      );
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("renames a temporary t3code/<hash> branch off the provisioning critical path", () =>
  Effect.gen(function* () {
    const branchNameStarted = yield* Deferred.make<void>();
    const allowBranchName = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/temp", refName: input.newRefName, headSha: "abc" },
        } as never),
      generateBranchName: () =>
        Deferred.succeed(branchNameStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:temp-branch",
          thread: "thread:launch:temp-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "t3code/abcd1234" },
        }),
      );
      yield* Deferred.await(branchNameStarted);
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "t3code/abcd1234");
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status === "starting")),
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
        "t3code/abcd1234",
      );
      yield* Deferred.succeed(allowBranchName, undefined);
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
      assert.deepEqual(harness.renameBranch.mock.calls[0]?.[0], {
        cwd: "/repo-worktrees/temp",
        oldBranch: "t3code/abcd1234",
        newBranch: "generated-branch",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("keeps an explicit branch name instead of generating one", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch(
        launchInput({
          command: "command:launch:explicit-branch",
          thread: "thread:launch:explicit-branch",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "my-feature" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.createWorktree.mock.calls.length === 1));
      assert.equal(harness.generateBranchName.mock.calls.length, 0);
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "my-feature");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("keeps the temporary branch when branch generation fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/temp", refName: input.newRefName, headSha: "abc" },
        } as never),
      generateBranchName: () => Effect.die("branch generation is down"),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:branch-fallback",
          thread: "thread:launch:branch-fallback",
          message: "Build the feature",
          workspace: { type: "worktree", baseRef: "main", branch: "t3code/abcd1234" },
        }),
      );
      yield* waitUntil(() => Effect.sync(() => harness.generateBranchName.mock.calls.length === 1));
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, "t3code/abcd1234");
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status === "starting")),
      );
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
        "t3code/abcd1234",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("renames a temporary branch on an existing worktree to a generated name", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:existing-worktree-rename",
          thread: "thread:launch:existing-worktree-rename",
          message: "Build the feature",
          workspace: {
            type: "existing_worktree",
            worktreePath: "/repo-worktrees/t3code-abcd1234",
            branch: "t3code/abcd1234",
          },
        }),
      );
      yield* waitUntil(() =>
        threads
          .getThreadProjection(launched.threadId)
          .pipe(Effect.map((projection) => projection.thread.branch === "generated-branch")),
      );
      assert.deepEqual(harness.renameBranch.mock.calls[0]?.[0], {
        cwd: "/repo-worktrees/t3code-abcd1234",
        oldBranch: "t3code/abcd1234",
        newBranch: "generated-branch",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("shows the fetch diagnosis when preparing a worktree from origin fails", () => {
  const detail =
    "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  const harness = makeHarness({
    fetchRemote: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.fetchRemote",
          command: "git",
          cwd: project.workspaceRoot,
          detail,
          exitCode: 128,
        }),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:fetch-failure",
        thread: "thread:launch:fetch-failure",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.messages[0]?.text, "Start from origin");
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(
      projection.turnItems.find((item) => item.type === "command_execution")?.status,
      "failed",
    );
    assert.include(
      projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
      detail,
    );
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(harness.runSetup.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retries a failed workspace preparation on the same run", () => {
  let fetchFailures = 1;
  const harness = makeHarness({
    fetchRemote: () =>
      fetchFailures-- > 0
        ? Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git",
              cwd: project.workspaceRoot,
              detail: "Git could not update a local reference.",
              exitCode: 1,
            }),
          )
        : Effect.void,
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:retry",
        thread: "thread:launch:retry",
        message: "Retry me",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
    );
    const failed = yield* threads.getThreadProjection(launched.threadId);
    const runId = failed.runs[0]!.id;
    assert.equal(
      failed.turnItems.find((item) => item.type === "error")?.failure.code,
      ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
    );

    const retry = {
      commandId: CommandId.make("command:launch:retry:1"),
      threadId: launched.threadId,
      runId,
    };
    yield* launches.retryPreparation(retry);
    yield* waitUntil(() =>
      outbox
        .listByCommandId(CommandId.make("command:launch:retry:1:release"))
        .pipe(Effect.map((effects) => effects.length === 1)),
    );
    const retried = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(retried.runs.length, 1);
    assert.equal(retried.runs[0]?.status, "starting");
    assert.equal(retried.thread.worktreePath, "/repo-worktrees/feature");
    assert.equal(retried.turnItems.find((item) => item.type === "error")?.status, "cancelled");
    assert.equal(
      retried.turnItems.find((item) => item.type === "command_execution")?.status,
      "completed",
    );
    assert.equal(harness.createWorktree.mock.calls.length, 1);

    // The run left preparation, so a second retry has nothing to do.
    const rejected = yield* launches
      .retryPreparation({ ...retry, commandId: CommandId.make("command:launch:retry:2") })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a retry reuses a recorded worktree without undoing its branch rename", () => {
  let setupFailures = 1;
  const harness = makeHarness({
    runSetup: () =>
      setupFailures-- > 0
        ? Effect.fail(new Error("setup failed") as never)
        : Effect.succeed({ status: "no-script" as const }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:reuse",
        thread: "thread:launch:reuse",
        message: "Reuse the worktree",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(
          Effect.map(
            (projection) =>
              projection.runs[0]?.status === "failed" &&
              projection.thread.branch === "generated-branch",
          ),
        ),
    );
    const failed = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(failed.thread.worktreePath, "/repo-worktrees/feature");

    yield* launches.retryPreparation({
      commandId: CommandId.make("command:launch:reuse:retry"),
      threadId: launched.threadId,
      runId: failed.runs[0]!.id,
    });
    yield* waitUntil(() =>
      outbox
        .listByCommandId(CommandId.make("command:launch:reuse:retry:release"))
        .pipe(Effect.map((effects) => effects.length === 1)),
    );
    const retried = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(retried.runs[0]?.status, "starting");
    // The retry neither checks out again nor puts back the temporary branch.
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.equal(harness.renameBranch.mock.calls.length, 1);
    assert.equal(retried.thread.branch, "generated-branch");
    assert.equal(retried.thread.worktreePath, "/repo-worktrees/feature");
    // Clients see the retry's setup, not the failed one it replaced.
    const snapshot = yield* tracker.get(launched.threadId);
    assert.equal(snapshot?.phase, "done");
    assert.deepEqual(
      snapshot?.stages.map((stage) => stage.id),
      ["setup-script", "agent"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("removes a worktree that failed before the thread recorded it", () => {
  const harness = makeHarness({
    // A checkout that dies after claiming its directory.
    createWorktree: (_input, options) =>
      (options?.progress?.onWorktreeClaimed?.("/repo-worktrees/partial") ?? Effect.void).pipe(
        Effect.andThen(Effect.fail(new Error("checkout failed") as never)),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:partial-worktree",
        thread: "thread:launch:partial-worktree",
        message: "Partial checkout",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* waitUntil(() =>
      threads
        .getThreadProjection(launched.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    // Unrecorded, so a retry would create a second checkout beside it.
    assert.equal(projection.thread.worktreePath, null);
    assert.deepEqual(
      harness.removeWorktree.mock.calls.map(([input]) => input.path),
      ["/repo-worktrees/partial"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["worktree", "setup"] as const)(
  "%s failure keeps the thread and message visible and emits failure items",
  (failurePoint) =>
    Effect.gen(function* () {
      const failure = new Error(`${failurePoint} failed`);
      const harness = makeHarness(
        failurePoint === "worktree"
          ? { createWorktree: () => Effect.fail(failure as never) }
          : { runSetup: () => Effect.fail(failure as never) },
      );
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const input = launchInput({
          command: `command:launch:${failurePoint}-failure`,
          thread: `thread:launch:${failurePoint}-failure`,
          message: `Fail during ${failurePoint}`,
          workspace: { type: "worktree", baseRef: "main" },
        });
        const launched = yield* launches.launch(input);
        yield* waitUntil(() =>
          threads
            .getThreadProjection(launched.threadId)
            .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.messages[0]?.text, `Fail during ${failurePoint}`);
        assert.equal(projection.runs[0]?.status, "failed");
        assert.equal(
          projection.turnItems.find((item) => item.type === "command_execution")?.status,
          "failed",
        );
        assert.match(
          projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
          new RegExp(`${failurePoint} failed`, "u"),
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
      });
      const first = yield* launches.launch(rest);
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    assert.equal(failed._tag, "ThreadLaunchError");
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch receipt from another project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-wrong-project",
      thread: "unused",
      message: "Wrong project",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        projectId: otherProjectId,
      })
      .pipe(Effect.flip);
    assert.equal(failed._tag, "ThreadLaunchError");
    assert.equal(failed.operation, "resolve-project");
    assert.equal(failed.threadId, first.threadId);
    assert.equal(failed.cause, "Project identity changed.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch retry after the thread is deleted", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-deleted",
      thread: "unused",
      message: "Deleted before retry",
    });
    const first = yield* launches.launch(rest);
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:launch:allocated-deleted:delete"),
      threadId: first.threadId,
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    assert.equal(failed._tag, "ThreadLaunchError");
    assert.equal(failed.operation, "create-thread");
    assert.equal(failed.threadId, first.threadId);
    assert.equal(failed.cause, "Thread not found.");
    const shells = yield* threads.listProjectThreads({ projectId, includeSubagents: true });
    assert.equal(shells.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    assert.equal(failed._tag, "ThreadLaunchError");
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
      });
      // The command receipt is reserved atomically with the winning create, so
      // a loser either replays the winner's stored events or surfaces a
      // transient replay conflict that the next attempt resolves — the race
      // can never persist a second thread.
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        assert.equal(error._tag, "ThreadLaunchError");
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("deduplicates retried launch side effects in-process", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({
        command: "command:launch:retry",
        thread: "thread:launch:retry",
        message: "Only once",
      });
      const [first, retry] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("schedules an accepted preparing message exactly once across concurrent retries", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:accepted-before-fork",
        thread: "thread:launch:accepted-before-fork",
        message: "Resume preparation",
      });
      const messageId = MessageId.make("message:launch:accepted-before-fork");

      yield* threads.dispatch({
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:initial-message`),
        threadId: input.threadId,
        messageId,
        text: "Resume preparation",
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const preparing = yield* threads.getThreadProjection(input.threadId);
      assert.equal(preparing.runs[0]?.status, "preparing");

      const [first, second] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.isTrue(first.resumed);
      assert.isTrue(second.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("creates a strong provider-thread mapping for an imported native session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:imported-native-session",
        thread: "thread:launch:imported-native-session",
      }),
      importedNativeThread: {
        ref: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-session-42",
          strength: "strong" as const,
        },
        metadata: {
          title: "Native session",
          updatedAt: "2026-08-23T00:00:00Z",
        },
      },
    };

    const launched = yield* launches.launch(input);

    assert.deepInclude(launched.projection.providerThreads[0], {
      id: IdAllocator.deriveProviderThread({
        driver: input.importedNativeThread.ref.driver,
        providerInstanceId: modelSelection.instanceId,
        nativeThreadId: input.importedNativeThread.ref.nativeId,
      }),
      driver: input.importedNativeThread.ref.driver,
      providerInstanceId: modelSelection.instanceId,
      appThreadId: input.threadId,
      nativeThreadRef: input.importedNativeThread.ref,
      status: "not_loaded",
      nativeMetadata: input.importedNativeThread.metadata,
    });
    assert.equal(
      launched.projection.thread.activeProviderThreadId,
      launched.projection.providerThreads[0]?.id,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  const harness = makeHarness();
  const files = ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-intake-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](t3-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        ...launches,
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    // The observer failed, but the real V2 message and its bytes were accepted.
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    assert.equal(
      (stored.context?.records[0] as { attachmentId: string }).attachmentId,
      stored.attachments[0]?.id,
    );
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const replayed = yield* ThreadMessageIntake.launchThread(input);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    // Both ordinary command intake (RPC) and send intake (MCP) use the same store.
    const dispatch = ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch;
    yield* dispatch;
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, files)));
});

it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([0, 1])("releases an async setup before its completion with exit %s", (exitCode) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
    const harness = makeHarness({
      runSetup: () =>
        Effect.succeed({
          status: "started" as const,
          async: true,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup",
          cwd: "/repo-worktrees/feature",
          completion: Deferred.await(completion),
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:async-${exitCode}`,
          thread: `thread:launch:async-${exitCode}`,
          message: "Start during setup",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
            true,
        ),
        Stream.runHead,
      );
      const running = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(running.runs[0]?.status, "starting");
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.equal(
        settled?.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

describe("delegate_task workspace", () => {
  const parentThreadId = ThreadId.make("thread:delegate-parent");
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:delegate"),
    requestNamespace: "provider-session:delegate",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:delegate",
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const codexProvider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  };

  const withDelegatingParent = <A, E>(
    harness: ReturnType<typeof makeHarness>,
    body: (
      service: OrchestratorMcp.OrchestratorMcpService["Service"],
    ) => Effect.Effect<
      A,
      E,
      ThreadManagement.ThreadManagementService | WorktreeSetupTracker.WorktreeSetupTracker
    >,
    parentWorkspace: { readonly branch: string | null; readonly worktreePath: string | null } = {
      branch: "feature/parent",
      worktreePath: "/repo-worktrees/parent",
    },
  ) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      // A parent on its own branch and worktree, mid-turn, like an agent calling delegate_task.
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:delegate-parent:create"),
        threadId: parentThreadId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        ...parentWorkspace,
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegate-parent:message"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:delegate-parent"),
        text: "Split the work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      return yield* body(yield* OrchestratorMcp.OrchestratorMcpService);
    }).pipe(
      Effect.provide(
        OrchestratorMcp.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              harness.layer,
              ProviderAdapterRegistry.makeLayer([adapter]),
              NodeCrypto.layer,
              Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
            ),
          ),
        ),
      ),
    );

  it.effect.each([
    { workspace: "worktree" },
    { role: "implementation" },
    { role: "test" },
  ] as const)("prepares an isolated child before its first turn (%j)", (workspaceChoice) =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<string>();
      const allowSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        providers: [codexProvider],
        runSetup: (input) =>
          Deferred.succeed(setupEntered, input.worktreePath).pipe(
            Effect.andThen(Deferred.await(allowSetup)),
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* withDelegatingParent(harness, (service) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          const request = {
            task: "Implement the parser",
            title: "Parser",
            ...workspaceChoice,
            clientRequestId: "parser",
          } as const;
          const task = yield* service.delegateTask(scope, request);
          const created = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(created.runs[0]?.status, "preparing");

          // Setup runs in the bound worktree while the child's run still waits to start.
          assert.equal(yield* Deferred.await(setupEntered), "/repo-worktrees/feature");
          const worktree = harness.createWorktree.mock.calls[0]![0];
          assert.equal(worktree.cwd, "/repo");
          assert.equal(worktree.refName, "feature/parent");
          assert.match(worktree.newRefName ?? "", /^t3code\/parser-[0-9a-f]{8}$/);
          const preparing = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(preparing.thread.worktreePath, "/repo-worktrees/feature");
          assert.equal(preparing.thread.branch, worktree.newRefName);
          assert.equal(preparing.runs[0]?.status, "preparing");

          // Retries with the same clientRequestId, during and after preparation, reuse it.
          assert.equal((yield* service.delegateTask(scope, request)).taskId, task.taskId);
          yield* Deferred.succeed(allowSetup, undefined);
          yield* tracker.stream(task.childThreadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
          const retried = yield* service.delegateTask(scope, request);
          assert.equal(retried.taskId, task.taskId);
          assert.equal(harness.createWorktree.mock.calls.length, 1);
          assert.equal(retried.worktreePath, "/repo-worktrees/feature");
          assert.equal(retried.branch, worktree.newRefName);
          const started = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(started.runs.length, 1);
          assert.equal(started.runs[0]?.status, "starting");
        }),
      );
    }),
  );

  it.effect.each([
    {},
    { role: "research" },
    { role: "review" },
    { role: "design" },
    { role: "implementation", workspace: "inherit" },
    { role: "test", workspace: "inherit" },
  ] as const)("keeps a child in the parent's checkout (%j)", (workspaceChoice) => {
    const harness = makeHarness({ providers: [codexProvider] });
    return withDelegatingParent(harness, (service) =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const task = yield* service.delegateTask(scope, {
          task: "Review the parser",
          ...workspaceChoice,
        });
        assert.equal(task.branch, "feature/parent");
        assert.equal(task.worktreePath, "/repo-worktrees/parent");
        assert.equal(harness.createWorktree.mock.calls.length, 0);
        const child = yield* threads.getThreadProjection(task.childThreadId);
        assert.equal(child.runs[0]?.status, "starting");
      }),
    );
  });

  // A thread started in the project root records no branch; its checkout says where it is.
  const rootParent = { branch: null, worktreePath: null };
  const checkoutStatus = (refName: string | null) => ({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: refName === "main",
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  });
  const rootCheckoutStatus = (refName: string | null) => () =>
    Effect.succeed(checkoutStatus(refName));
  // A checkout whose status is cached until invalidated, like the git service's.
  const switchableCheckout = (initial: string | null) => {
    let head = initial;
    let cached: string | null | undefined;
    return {
      localStatus: () =>
        Effect.sync(() => {
          if (cached === undefined) cached = head;
          return checkoutStatus(cached);
        }),
      invalidateLocalStatus: () =>
        Effect.sync(() => {
          cached = undefined;
        }),
      switchTo: (refName: string | null) => {
        head = refName;
      },
    };
  };

  it.effect("cuts a root thread's implementation child from the branch its checkout is on", () => {
    const harness = makeHarness({
      providers: [codexProvider],
      localStatus: rootCheckoutStatus("main"),
    });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          const task = yield* service.delegateTask(scope, {
            task: "Implement the parser",
            role: "implementation",
          });
          assert.isUndefined(task.workspaceNote);
          yield* tracker.stream(task.childThreadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
          assert.equal(harness.localStatus.mock.calls[0]?.[0]?.cwd, "/repo");
          const worktree = harness.createWorktree.mock.calls[0]![0];
          assert.equal(worktree.cwd, "/repo");
          assert.equal(worktree.refName, "main");
        }),
      rootParent,
    );
  });

  it.effect("keeps a defaulted child in a detached checkout and says so", () => {
    const harness = makeHarness({
      providers: [codexProvider],
      localStatus: rootCheckoutStatus(null),
    });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const task = yield* service.delegateTask(scope, {
            task: "Implement the parser",
            role: "implementation",
          });
          assert.isString(task.workspaceNote);
          assert.isNull(task.worktreePath);
          assert.equal(harness.createWorktree.mock.calls.length, 0);
          const child = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(child.runs[0]?.status, "starting");
        }),
      rootParent,
    );
  });

  it.effect("rejects an explicit worktree from a detached checkout", () => {
    const harness = makeHarness({
      providers: [codexProvider],
      localStatus: rootCheckoutStatus(null),
    });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const error = yield* service
            .delegateTask(scope, { task: "Implement the parser", workspace: "worktree" })
            .pipe(Effect.flip);
          assert.equal(error.code, "invalid_request");
          assert.include(error.message, "detached HEAD");
        }),
      rootParent,
    );
  });

  it.effect("cuts the child from a branch switched to just before delegating", () => {
    const checkout = switchableCheckout("main");
    const harness = makeHarness({ providers: [codexProvider], ...checkout });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          yield* harness.localStatus({ cwd: "/repo" });
          checkout.switchTo("feature/switched");
          const task = yield* service.delegateTask(scope, {
            task: "Implement the parser",
            role: "implementation",
          });
          yield* tracker.stream(task.childThreadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
          assert.equal(harness.createWorktree.mock.calls[0]![0].refName, "feature/switched");
        }),
      rootParent,
    );
  });

  it.effect.each([{ role: "implementation" }, { workspace: "worktree" }] as const)(
    "keeps an accepted worktree child when a retry finds the checkout detached (%j)",
    (workspaceChoice) => {
      const checkout = switchableCheckout("main");
      const harness = makeHarness({ providers: [codexProvider], ...checkout });
      return withDelegatingParent(
        harness,
        (service) =>
          Effect.gen(function* () {
            const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
            const request = {
              task: "Implement the parser",
              ...workspaceChoice,
              clientRequestId: "detached-retry",
            };
            const task = yield* service.delegateTask(scope, request);
            yield* tracker.stream(task.childThreadId).pipe(
              Stream.filter((snapshot) => snapshot?.phase === "done"),
              Stream.runHead,
            );
            checkout.switchTo(null);
            const retried = yield* service.delegateTask(scope, request);
            assert.equal(retried.taskId, task.taskId);
            assert.isUndefined(retried.workspaceNote);
            assert.equal(retried.worktreePath, "/repo-worktrees/feature");
            assert.equal(harness.createWorktree.mock.calls.length, 1);
          }),
        rootParent,
      );
    },
  );
});

describe("managed issue work", () => {
  const exercise = (scenario: "baseline" | "direct-resume" | "deletion") => {
    const provider: ServerProvider = {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
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
    };
    const issue = {
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repository:8",
      id: "issue:8",
      nodeId: "node:8",
      number: 8,
      url: "https://github.com/tannerpolley/t3code/issues/8",
      title: "Single issue",
    };
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: { ...issue, number: input.number },
        state: "open" as const,
        milestoneNumber: null,
        parent: null,
        subIssues: [],
        blockedBy: [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: true,
      });
    const harness = makeHarness({
      issueServiceLayer: Layer.mock(IssueService.IssueService)({ workRead }),
      providers: [provider],
      projectRepositoryIdentity: {
        canonicalKey: "github.com/tannerpolley/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/tannerpolley/t3code.git",
        },
        provider: "github",
        owner: "tannerpolley",
        name: "t3code",
        displayName: "tannerpolley/t3code",
      },
      serverSettings: {
        modelRoles: [
          {
            id: "worker",
            name: "Worker",
            description: "Issue worker",
            targets: [
              { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
            ],
          },
        ],
      },
    });
    const store = IssueWorkStore.layer.pipe(Layer.provide(harness.layer));
    const published = new Map<string, { commentId: string; body: string }>();
    const writeCalls: Array<
      Parameters<IssueService.IssueService["Service"]["writeManagedComment"]>[0]
    > = [];
    const issueReads = Layer.mock(IssueService.IssueService)({
      workRead,
      writeManagedComment: (request) =>
        Effect.sync(() => {
          writeCalls.push(request);
          const commentId =
            published.get(request.marker)?.commentId ?? `comment-${published.size + 1}`;
          published.set(request.marker, { commentId, body: request.body });
          return { commentId };
        }),
      resolveLinkedIssue: () => Effect.succeed(issue),
      detail: () =>
        Effect.succeed({
          repository: { host: issue.host, repository: issue.repository },
          viewer: null,
          fetchedAt: "2026-10-05T00:00:00Z",
          issue: {
            number: issue.number,
            title: issue.title,
            url: issue.url,
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
          body: "Finish this issue",
          comments: [],
          linkedPullRequests: [],
        }),
    });
    const dependencies = Layer.mergeAll(
      harness.layer,
      store,
      issueReads,
      IdAllocator.layer,
      ProviderAdapterRegistry.makeLayer([adapter]),
    );
    const service = IssueWorkService.layer.pipe(Layer.provide(dependencies));
    const realExecutor = Layer.fresh(EffectWorker.executorLayer).pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
          Layer.mock(RunFinalizationService.RunFinalizationService)({}),
          Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
          Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
          Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        ),
      ),
    );
    // Exercise the real comment executor/worker; provider subprocess effects are
    // deliberately inert in this offline proof.
    const commentExecutor = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect, options) =>
            effect.request.type === "issue.github.comment" ||
            effect.request.type === "issue.status.refresh"
              ? executor.execute(effect, options)
              : Effect.void,
        });
      }),
    ).pipe(Layer.provide(realExecutor));
    const commentWorker = EffectWorker.layerWithOptions({}).pipe(
      Layer.provide(Layer.mergeAll(dependencies, commentExecutor)),
    );
    const testLayer = Layer.mergeAll(service, commentExecutor, commentWorker).pipe(
      Layer.provideMerge(dependencies),
    );
    return Effect.gen(function* () {
      const issues = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const input = {
        host: issue.host,
        repository: issue.repository,
        number: issue.number,
        projectId,
        modelRoleId: "worker",
        workspace: "project" as const,
      };
      const starts = yield* Effect.all(
        [
          issues.start({ ...input, clientRequestId: CommandId.make("issue-click:first") }),
          issues.start({ ...input, clientRequestId: CommandId.make("issue-click:second") }),
        ],
        { concurrency: 2 },
      );
      assert.equal(starts[0].rootThreadId, starts[1].rootThreadId);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_repository_orchestration`).length,
        1,
      );
      const root = yield* threads.getThreadProjection(starts[0].rootThreadId);
      assert.equal(root.messages.length, 1);
      assert.equal((yield* issues.workStatus(input)).status, "queued_preparing");
      assert.equal((yield* issues.workStatus(input)).projectId, projectId);
      const unstartedIssue = yield* issues.workStatus({
        host: issue.host,
        repository: issue.repository,
        number: 9,
      });
      assert.equal(unstartedIssue.projectId, projectId);
      assert.equal(unstartedIssue.rootThreadId, root.thread.id);
      assert.isNull(unstartedIssue.status);
      assert.isNull(yield* (yield* IssueWorkStore.IssueWorkStore).issueOwner(issue));
      const otherProjectStart = yield* issues
        .start({
          ...input,
          projectId: otherProjectId,
          clientRequestId: CommandId.make("issue-click:other-project"),
        })
        .pipe(Effect.result);
      assert.isTrue(otherProjectStart._tag === "Failure");
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_repository_orchestration`).length,
        1,
      );
      yield* worker.drain();
      assert.equal(published.size, 1);
      assert.isNull(yield* (yield* IssueWorkStore.IssueWorkStore).issueOwner(issue));
      const parentRun = root.runs[0]!;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("issue-delegate:first"),
        parentThreadId: root.thread.id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        issue,
        task: "Finish the issue",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        completionWake: "always" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const missingIssue = yield* threads
        .dispatch({
          ...command,
          commandId: CommandId.make("issue-delegate:missing"),
          issue: undefined,
        })
        .pipe(Effect.result);
      assert.isTrue(missingIssue._tag === "Failure");
      const concurrent = yield* Effect.all(
        [
          threads.dispatch(command).pipe(Effect.result),
          threads
            .dispatch({ ...command, commandId: CommandId.make("issue-delegate:concurrent") })
            .pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      const successful = concurrent.filter((result) => result._tag === "Success");
      assert.equal(successful.length, 1);
      assert.equal(concurrent.filter((result) => result._tag === "Failure").length, 1);
      const acceptedDelegate = successful[0];
      if (acceptedDelegate?._tag !== "Success")
        return yield* Effect.die("No accepted issue worker");
      const delegated = acceptedDelegate.success;
      const taskEvent = delegated.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      assert.isDefined(taskEvent);
      if (
        taskEvent?.event.type !== "subagent.updated" ||
        taskEvent.event.payload.childThreadId === null
      )
        return yield* Effect.die("No issue worker");
      const child = yield* threads.getThreadProjection(taskEvent.event.payload.childThreadId);
      assert.deepEqual(child.thread.linkedIssue, issue);
      assert.equal(child.thread.title, "#8 Single issue");
      const duplicate = yield* threads
        .dispatch({ ...command, commandId: CommandId.make("issue-delegate:duplicate") })
        .pipe(Effect.result);
      assert.isTrue(duplicate._tag === "Failure");
      assert.equal((yield* threads.getThreadProjection(root.thread.id)).subagents.length, 1);
      const archive = yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("issue-root:archive"),
          threadId: root.thread.id,
        })
        .pipe(Effect.result);
      assert.isTrue(archive._tag === "Failure");
      const deletion = yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make("issue-root:delete"),
          threadId: root.thread.id,
        })
        .pipe(Effect.result);
      assert.isTrue(deletion._tag === "Failure");
      const childRun = child.runs[0]!;
      const now = yield* DateTime.now;
      if (childRun.activeAttemptId === null) return yield* Effect.die("No current worker attempt");
      const running = { ...childRun, status: "running" as const, startedAt: now };
      const started = yield* sink.writeIfRunCurrent({
        threadId: child.thread.id,
        runId: childRun.id,
        activeAttemptId: childRun.activeAttemptId,
        expectedStatus: childRun.status,
        events: [
          {
            id: EventId.make("issue-worker:running"),
            type: "run.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: running,
          },
        ],
      });
      assert.isTrue(started.committed);
      assert.equal((yield* issues.workStatus(input)).status, "working");
      yield* worker.drain();
      const request: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("issue-native-permission"),
        nodeId: childRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "permission-1",
          strength: "strong",
        },
        kind: "permission",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:native-permission"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: request,
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "waiting_on_you");
      const dynamicRequest: OrchestrationV2RuntimeRequest = {
        ...request,
        id: RuntimeRequestId.make("issue-native-dynamic-tool"),
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "dynamic-1",
          strength: "strong",
        },
        kind: "dynamic_tool_call",
        createdAt: DateTime.add(now, { milliseconds: 1 }),
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:newer-dynamic-tool"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: dynamicRequest.createdAt,
            payload: dynamicRequest,
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "waiting_on_you");
      assert.equal(
        (yield* threads.getThreadShell(child.thread.id))?.pendingRuntimeRequest?.kind,
        "dynamic_tool_call",
      );
      yield* worker.drain();
      const waitingRows = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'issue.github.comment' AND json_extract(payload_json, '$.status') = 'waiting_on_you' ORDER BY rowid DESC LIMIT 1`;
      const staleWaiting = Option.getOrThrow(yield* outbox.get(waitingRows[0]!.effect_id));
      yield* worker.drain();
      assert.isTrue(
        [...published.values()].some((comment) => comment.body.includes("Waiting on you")),
      );
      if (scenario === "deletion") {
        yield* threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("issue-worker:delete"),
          threadId: child.thread.id,
        });
        assert.equal((yield* issues.workStatus(input)).status, "unavailable");
        // The latest published key still names Waiting on you until refresh runs.
        // Replaying it here proves deletion itself rejects stale writes.
        const before = writeCalls.length;
        yield* executor.execute(staleWaiting);
        assert.equal(writeCalls.length, before);
        yield* worker.drain();
        const statuses = writeCalls.filter((call) => call.operation === "status_sync");
        assert.include(statuses.at(-1)!.body, "Unavailable");
        const afterDeletion = writeCalls.length;
        yield* executor.execute(staleWaiting);
        assert.equal(writeCalls.length, afterDeletion);
        return;
      }
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:permission-answered"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...request, status: "resolved", resolvedAt: now },
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "working");
      yield* worker.drain();
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:dynamic-resolved"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...dynamicRequest, status: "resolved", resolvedAt: now },
          },
          {
            id: EventId.make("issue-worker:permission-resolved"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...request, status: "resolved", resolvedAt: now },
          },
          {
            id: EventId.make("issue-worker:final-message"),
            type: "message.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("issue-final-message"),
              threadId: child.thread.id,
              runId: childRun.id,
              nodeId: childRun.rootNodeId,
              role: "assistant",
              text: "Implementation complete. Focused checks passed; push approval remains.",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          },
          {
            id: EventId.make("issue-worker:finished"),
            type: "run.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...running, status: "completed", completedAt: now },
          },
        ],
      });
      const beforeStaleRetry = writeCalls.length;
      yield* executor.execute(staleWaiting);
      assert.equal(writeCalls.length, beforeStaleRetry);
      yield* orchestrator.recoverDelegatedTask(child.thread.id, childRun.id);
      yield* worker.drain();
      assert.equal(published.size, 2);
      assert.equal(writeCalls.filter((call) => call.operation === "closeout_create").length, 1);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
        1,
      );
      const closeouts = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE json_extract(payload_json, '$.operation') = 'closeout_create'`;
      assert.equal(closeouts.length, 1);
      const closeout = Option.getOrThrow(yield* outbox.get(closeouts[0]!.effect_id));
      yield* executor.execute(closeout);
      yield* orchestrator.recoverDelegatedTask(child.thread.id, childRun.id);
      yield* worker.drain();
      assert.equal(writeCalls.filter((call) => call.operation === "closeout_create").length, 1);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
        1,
      );
      assert.equal((yield* issues.workStatus(input)).status, "done");
      if (scenario === "direct-resume") {
        const beforeTransfers = (yield* threads.getThreadProjection(
          root.thread.id,
        )).contextTransfers.filter((transfer) => transfer.type === "subagent_result").length;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("issue-worker:direct-followup"),
          threadId: child.thread.id,
          messageId: MessageId.make("issue-worker:direct-followup"),
          text: "Finish the local follow-up",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const resumed = (yield* threads.getThreadProjection(child.thread.id)).runs.at(-1)!;
        const finishedAt = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("issue-worker:followup-result"),
              type: "message.updated",
              threadId: child.thread.id,
              runId: resumed.id,
              occurredAt: finishedAt,
              payload: {
                id: MessageId.make("issue-worker:followup-result"),
                threadId: child.thread.id,
                runId: resumed.id,
                nodeId: resumed.rootNodeId,
                role: "assistant",
                text: "Follow-up complete.",
                attachments: [],
                streaming: false,
                createdAt: finishedAt,
                updatedAt: finishedAt,
                createdBy: "agent",
                creationSource: "provider",
              },
            },
            {
              id: EventId.make("issue-worker:followup-finished"),
              type: "run.updated",
              threadId: child.thread.id,
              runId: resumed.id,
              occurredAt: finishedAt,
              payload: {
                ...resumed,
                status: "completed",
                startedAt: finishedAt,
                completedAt: finishedAt,
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTask(child.thread.id, resumed.id);
        yield* worker.drain();
        yield* orchestrator.recoverDelegatedTask(child.thread.id, resumed.id);
        yield* worker.drain();
        const closeoutCalls = writeCalls.filter((call) => call.operation === "closeout_create");
        assert.equal(closeoutCalls.length, 2);
        assert.include(closeoutCalls[1]!.body, "Follow-up complete.");
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
          2,
        );
        assert.equal(
          (yield* threads.getThreadProjection(root.thread.id)).contextTransfers.filter(
            (transfer) => transfer.type === "subagent_result",
          ).length,
          beforeTransfers,
        );
        return;
      }
      const retry = yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:first"),
      });
      assert.equal(retry.rootThreadId, root.thread.id);
      assert.equal(
        (yield* threads.getThreadProjection(root.thread.id)).messages.filter((message) =>
          message.text.startsWith("Start issue #8:"),
        ).length,
        1,
      );
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_work_requests`).length,
        2,
      );
      const issueStore = yield* IssueWorkStore.IssueWorkStore;
      const successor = yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:successor"),
      });
      assert.equal(successor.rootThreadId, root.thread.id);
      assert.equal(yield* issueStore.issueOwner(issue), child.thread.id);
      assert.equal((yield* issues.workStatus(input)).status, "queued_preparing");
      assert.isNull((yield* issues.workStatus(input)).threadId);
      yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:successor-duplicate"),
      });
      assert.equal(
        (yield* threads.getThreadProjection(root.thread.id)).messages.filter((message) =>
          message.text.startsWith("Start issue #8:"),
        ).length,
        2,
      );
      yield* issues.start({ ...input, clientRequestId: CommandId.make("issue-click:first") });
      assert.equal(
        (yield* threads.getThreadProjection(root.thread.id)).messages.filter((message) =>
          message.text.startsWith("Start issue #8:"),
        ).length,
        2,
      );
      const successorResult = yield* threads.dispatch({
        ...command,
        commandId: CommandId.make("issue-delegate:successor"),
      });
      const successorTask = successorResult.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      if (
        successorTask?.event.type !== "subagent.updated" ||
        successorTask.event.payload.childThreadId === null
      )
        return yield* Effect.die("No successor worker");
      assert.equal(yield* issueStore.issueOwner(issue), successorTask.event.payload.childThreadId);
      assert.deepEqual(
        (yield* threads.getThreadProjection(child.thread.id)).thread.lineage,
        child.thread.lineage,
      );
      assert.equal((yield* threads.getThreadProjection(root.thread.id)).subagents.length, 2);
    }).pipe(Effect.provide(testLayer));
  };

  it.effect(
    "issue starts share one durable root and queued request, and retries cannot start another attempt",
    () => exercise("baseline"),
  );
  it.effect(
    "a directly resumed worker publishes one closeout per completed run without owing another parent result",
    () => exercise("direct-resume"),
  );
  it.effect(
    "deleting a waiting worker publishes Unavailable and drops an older queued status",
    () => exercise("deletion"),
  );
});

it.effect(
  "shares four slots across a nested issue tree, guards parents and eligibility, queues resumes, pauses admission, and wakes the root on completion",
  () => {
    const issue = (number: number) => ({
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:milestone",
      id: `issue:${number}`,
      nodeId: `node:${number}`,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/tannerpolley/t3code/issues/${number}`,
    });
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: issue(input.number),
        state: "open" as const,
        milestoneNumber: 1,
        parent: input.number === 4 ? issue(1) : null,
        subIssues: input.number === 1 ? [issue(4)] : [],
        blockedBy: input.number === 6 ? [{ issue: issue(99), state: "open" as const }] : [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: input.number !== 7,
      });
    const harness = makeHarness({
      runContinuationWorker: true,
      adapters: [adapter, { ...adapter, instanceId: ProviderInstanceId.make("codex-second") }],
      issueServiceLayer: Layer.mock(IssueService.IssueService)({ workRead }),
    });
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const rootId = ThreadId.make("milestone-root");
      const config = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        repositoryId: "repo:milestone",
        projectId,
        workspace: "project" as const,
        launchCommandId: CommandId.make("milestone-root-create"),
        revision: 1,
        paused: false,
        workerLimit: 4,
        publishStatusComments: true,
        publishCloseoutComments: true,
        milestones: [
          {
            number: 1,
            modelRoleId: "worker",
            workspace: "project" as const,
            status: "running" as const,
            fingerprint: "",
          },
        ],
        suspendedIssues: [],
      };
      yield* threads.dispatch({
        type: "thread.create",
        commandId: config.launchCommandId,
        threadId: rootId,
        projectId,
        title: "Repository orchestrator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        repositoryOrchestration: config,
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("milestone-root-start"),
        threadId: rootId,
        messageId: MessageId.make("milestone-root-start"),
        text: "Work through milestone 1",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const delegate = (
        number: number,
        parentThreadId = rootId,
        key = `milestone-delegate:${number}`,
        withWorktree = false,
      ) =>
        Effect.gen(function* () {
          const projection = yield* threads.getThreadRecords(parentThreadId, ["runs"]);
          const run = projection.runs.findLast((entry) =>
            ["starting", "running", "waiting"].includes(entry.status),
          )!;
          const result = yield* threads.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(key),
            parentThreadId,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            issue: issue(number),
            task: `Finish issue ${number}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            ...(withWorktree ? { worktree: { baseRef: "main", branch: "issue-worker" } } : {}),
            createdBy: "agent",
            creationSource: "mcp",
          });
          const created = result.storedEvents.find(
            (stored) => stored.event.type === "thread.created",
          );
          if (created?.event.type !== "thread.created")
            return yield* Effect.die("No worker created");
          return created.event.threadId;
        });
      const first = yield* delegate(1);
      const second = yield* delegate(2);
      const third = yield* delegate(3);
      assert.equal(
        (yield* delegate(4, rootId, "wrong-parent").pipe(Effect.result))._tag,
        "Failure",
      );
      const waitingRun = (yield* threads.getThreadRecords(first, ["runs"])).runs[0]!;
      const questionAt = yield* DateTime.now;
      const question: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("milestone-question"),
        nodeId: waitingRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "milestone-question",
          strength: "strong",
        },
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: questionAt,
        resolvedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("milestone-question"),
            type: "runtime-request.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: question,
          },
          {
            id: EventId.make("milestone-waiting"),
            type: "run.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: { ...waitingRun, status: "waiting" },
          },
        ],
      });
      const [nested, fifth] = yield* Effect.all([delegate(4, first), delegate(5)], {
        concurrency: 2,
      });
      assert.equal(
        (yield* threads.getThreadRecords(nested, [])).thread.lineage.parentThreadId,
        first,
      );
      const status = (id: ThreadId) =>
        threads
          .getThreadRecords(id, ["runs"])
          .pipe(Effect.map((projection) => projection.runs.at(-1)!.status));
      assert.deepEqual([yield* status(nested), yield* status(fifth)].sort(), [
        "queued",
        "starting",
      ]);
      const queued = (yield* status(nested)) === "queued" ? nested : fifth;
      const sql = yield* SqlClient.SqlClient;
      const starts = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${queued} AND effect_type = 'provider-turn.start'`;
      assert.equal(starts.length, 0);
      assert.equal((yield* delegate(6).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* delegate(7).pipe(Effect.result))._tag, "Failure");
      const finish = (id: ThreadId, key: string) =>
        Effect.gen(function* () {
          const run = (yield* threads.getThreadRecords(id, ["runs"])).runs.findLast(
            (entry) => entry.status !== "queued",
          )!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${key}:result`),
                type: "message.updated",
                threadId: id,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`${key}:result`),
                  threadId: id,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  role: "assistant",
                  text: "Finished.",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: "agent",
                  creationSource: "provider",
                },
              },
              {
                id: EventId.make(`${key}:finish`),
                type: "run.updated",
                threadId: id,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        });
      const waitForStart = (id: ThreadId, sequence: number) =>
        sink.stream({ afterSequence: sequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === id &&
              stored.event.type === "run.updated" &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      assert.equal(yield* status(first), "waiting");
      yield* sink.write({
        events: [
          {
            id: EventId.make("milestone-answer"),
            type: "runtime-request.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: { ...question, status: "resolved", resolvedAt: questionAt },
          },
        ],
      });
      const beforeFirstFinish = yield* sink.latestSequence();
      yield* finish(first, "parent-turn-ended");
      yield* waitForStart(queued, beforeFirstFinish);
      assert.equal(yield* status(queued), "starting");
      // The parent owns unfinished nested work, but its completed turn released its slot.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-resume"),
        threadId: first,
        messageId: MessageId.make("parent-resume"),
        text: "Continue",
        attachments: [],
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("codex-second") },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(yield* status(first), "queued");
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make("pause-plan"),
        threadId: rootId,
        expectedRevision: 1,
        orchestration: { ...config, paused: true },
      });
      yield* finish(rootId, "root-waits");
      const beforeLeafFinish = yield* sink.latestSequence();
      yield* finish(second, "second-done");
      yield* sink.stream({ afterSequence: beforeLeafFinish, eventType: "run.created" }).pipe(
        Stream.filter((stored) => stored.event.threadId === rootId),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* threads.dispatch({
        type: "queue.resume",
        threadId: first,
        commandId: CommandId.make("resume-while-paused"),
      });
      assert.equal(yield* status(first), "queued");
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make("resume-plan"),
        threadId: rootId,
        expectedRevision: 2,
        orchestration: { ...config, revision: 2, paused: false },
      });
      yield* threads.dispatch({
        type: "queue.resume",
        threadId: first,
        commandId: CommandId.make("resume-after-pause"),
      });
      assert.equal(yield* status(first), "starting");
      const preparingWorker = yield* delegate(8, rootId, "worktree-worker", true);
      assert.equal(yield* status(preparingWorker), "queued");
      const beforePreparation = yield* sink.latestSequence();
      yield* finish(third, "release-preparation-slot");
      yield* sink.stream({ afterSequence: beforePreparation, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === preparingWorker &&
            stored.event.type === "run.updated" &&
            stored.event.payload.status === "preparing",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const preparing = (yield* threads.getThreadRecords(preparingWorker, ["runs"])).runs[0]!;
      const failedAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("workspace-preparation-failed"),
            type: "run.updated",
            threadId: preparingWorker,
            runId: preparing.id,
            occurredAt: failedAt,
            payload: { ...preparing, status: "failed", completedAt: failedAt },
          },
        ],
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("worktree-provider-resume"),
        threadId: preparingWorker,
        messageId: MessageId.make("worktree-provider-resume"),
        text: "Retry using the other provider instance",
        attachments: [],
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("codex-second") },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const resumedPreparation = (yield* threads.getThreadRecords(preparingWorker, [
        "runs",
      ])).runs.at(-1)!;
      assert.equal(resumedPreparation.status, "preparing");
      assert.equal(resumedPreparation.workspacePreparation?.type, "worktree");
      const prematureStarts =
        yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${preparingWorker} AND effect_type = 'provider-turn.start'`;
      assert.equal(prematureStarts.length, 0);
      const root = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
      assert.isTrue(root.runs.length > 1);
      assert.isTrue(
        root.messages.some(
          (message) =>
            message.notification !== undefined || message.delegatedCompletion !== undefined,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "starts ancestor owners for milestone work, reports blocked and unreadable plans, and suspends externally changed branches without rewriting lineage",
  () => {
    const linked = (number: number) => ({
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:plans",
      id: `issue:${number}`,
      nodeId: `node:${number}`,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/tannerpolley/t3code/issues/${number}`,
    });
    let newBlocker = false;
    let reparented = false;
    const milestoneNumber = (number: number) =>
      number <= 2 ? 1 : number === 3 ? 2 : number === 4 ? 3 : number === 5 ? 4 : 6;
    const summary = (number: number) => ({
      number,
      title: `Issue ${number}`,
      url: linked(number).url,
      state: "open" as const,
      stateReason: null,
      author: null,
      assignees: [],
      labels: [],
      milestone: {
        number: milestoneNumber(number),
        title: `Milestone ${milestoneNumber(number)}`,
        state: "open" as const,
        dueAt: null,
        url: "https://github.com/tannerpolley/t3code/milestone/1",
        openCount: 1,
        closedCount: 0,
      },
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
      commentCount: 0,
    });
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: linked(input.number),
        state: "open" as const,
        milestoneNumber: milestoneNumber(input.number),
        parent:
          input.number === 2 && !reparented ? linked(1) : input.number === 3 ? linked(9) : null,
        subIssues: input.number === 1 ? [linked(2)] : [],
        blockedBy:
          input.number === 4 || (input.number === 2 && newBlocker)
            ? [{ issue: linked(99), state: "open" as const }]
            : [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: input.number !== 5,
      });
    const reads = Layer.mock(IssueService.IssueService)({
      workRead,
      repositoryIdentity: () =>
        Effect.succeed({
          host: "github.com",
          repository: "tannerpolley/t3code",
          repositoryId: "repo:plans",
        }),
      milestoneIssues: (input) =>
        Effect.succeed({
          issues: [1, 2, 3, 4, 5]
            .map(summary)
            .filter((issue) => issue.milestone.number === input.milestoneNumber),
          complete: true,
        }),
      detail: (input) =>
        Effect.succeed({
          repository: { host: "github.com", repository: "tannerpolley/t3code" },
          viewer: null,
          fetchedAt: "2026-10-05T00:00:00Z",
          issue: summary(input.number),
          body: "Finish this issue",
          comments: [],
          linkedPullRequests: [],
        }),
      resolveLinkedIssue: (input) => Effect.succeed(linked(input.number)),
    });
    const provider: ServerProvider = {
      instanceId: modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
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
    };
    const harness = makeHarness({
      issueServiceLayer: reads,
      providers: [provider],
      projectRepositoryIdentity: {
        canonicalKey: "github.com/tannerpolley/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/tannerpolley/t3code.git",
        },
        provider: "github",
        owner: "tannerpolley",
        name: "t3code",
        displayName: "tannerpolley/t3code",
      },
      serverSettings: {
        modelRoles: [
          {
            id: "worker",
            name: "Worker",
            description: "Issue worker",
            targets: [
              { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
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
      ProviderAdapterRegistry.makeLayer([adapter]),
    );
    const serviceLayer = IssueWorkService.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const input = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        projectId,
        modelRoleId: "worker",
        workspace: "project" as const,
      };
      const emptyPlan = yield* service.workMilestone({
        ...input,
        milestoneNumber: 5,
        clientRequestId: CommandId.make("empty-plan"),
      });
      assert.isNotNull(emptyPlan.rootThreadId);
      assert.equal(emptyPlan.orchestration?.milestones[0]?.status, "complete");
      const plan = yield* service.workMilestone({
        ...input,
        milestoneNumber: 1,
        clientRequestId: CommandId.make("plan:1"),
      });
      const rootId = plan.rootThreadId!;
      const root = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
      assert.equal(root.messages.length, 1);
      assert.include(root.messages[0]!.text, "Start issue #1:");
      const command = (
        number: number,
        parentThreadId: ThreadId,
        run: (typeof root.runs)[number],
      ) => ({
        type: "delegated_task.request" as const,
        commandId: CommandId.make(`plan:delegate:${number}`),
        parentThreadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        issue: linked(number),
        task: "Finish issue",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        completionWake: "always" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      });
      const sequence = yield* sink.latestSequence();
      const first = yield* threads.dispatch(command(1, rootId, root.runs[0]!));
      const firstId = first.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.threadId;
      yield* sink.stream({ afterSequence: sequence, eventType: "message.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === firstId &&
            stored.event.type === "message.updated" &&
            stored.event.payload.text.includes("Start your authorized sub-issue #2"),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const parent = yield* threads.getThreadRecords(firstId, ["runs"]);
      assert.equal(parent.runs[0]!.status, "starting");
      const second = yield* threads.dispatch(command(2, firstId, parent.runs[0]!));
      const secondId = second.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.threadId;
      assert.equal(
        (yield* threads.getThreadRecords(secondId, [])).thread.lineage.parentThreadId,
        firstId,
      );
      newBlocker = true;
      yield* service.reconcile(rootId);
      let state = yield* service.repositoryStatus(input);
      assert.isTrue(
        state.orchestration!.suspendedIssues.some(
          (entry) => entry.id === "issue:2" && entry.reason.includes("blocker"),
        ),
      );
      assert.equal(
        (yield* threads.getThreadRecords(secondId, ["runs"])).runs[0]?.status,
        "interrupted",
      );
      newBlocker = false;
      yield* service.setPaused({
        ...input,
        paused: false,
        clientRequestId: CommandId.make("plan:resume-after-blocker"),
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: secondId,
        commandId: CommandId.make("plan:worker-resume"),
        messageId: MessageId.make("plan:worker-resume"),
        text: "Resume the issue",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      reparented = true;
      yield* service.setPaused({
        ...input,
        paused: true,
        clientRequestId: CommandId.make("plan:pause"),
      });
      assert.isTrue((yield* service.repositoryStatus(input)).orchestration!.paused);
      yield* service.setPaused({
        ...input,
        paused: false,
        clientRequestId: CommandId.make("plan:resume"),
      });
      state = yield* service.repositoryStatus(input);
      assert.isTrue(
        state.orchestration!.suspendedIssues.some(
          (entry) => entry.id === "issue:2" && entry.reason.includes("re-parented"),
        ),
      );
      assert.equal(
        (yield* threads.getThreadRecords(secondId, [])).thread.lineage.parentThreadId,
        firstId,
      );
      for (const [number, status] of [
        [2, "awaiting_approval"],
        [3, "blocked"],
        [4, "unreadable"],
        [5, "complete"],
      ] as const) {
        const result = yield* service.workMilestone({
          ...input,
          milestoneNumber: number,
          clientRequestId: CommandId.make(`plan:${number}`),
        });
        assert.equal(
          result.orchestration!.milestones.find((entry) => entry.number === number)?.status,
          status,
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(dependencies, serviceLayer)));
  },
);

describe("fresh-thread repository handoff", () => {
  const reference = { host: "github.com", repository: "tannerpolley/t3code" };
  const rootId = ThreadId.make("handoff-root");
  const linked = (number: number) => ({
    ...reference,
    repositoryId: "repo:handoff",
    id: `issue:${number}`,
    nodeId: `node:${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/tannerpolley/t3code/issues/${number}`,
  });
  const plan = {
    number: 1,
    modelRoleId: "worker",
    workspace: "project" as const,
    status: "running" as const,
    fingerprint: "",
  };
  const config = {
    ...reference,
    repositoryId: "repo:handoff",
    projectId,
    workspace: "project" as const,
    launchCommandId: CommandId.make("handoff-root-create"),
    revision: 1,
    paused: false,
    workerLimit: 4,
    publishStatusComments: true,
    publishCloseoutComments: true,
    milestones: [plan],
    suspendedIssues: [],
  };
  const summary = (number: number) => ({
    ...linked(number),
    state: "open" as const,
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone: {
      number: 1,
      title: "First milestone",
      state: "open" as const,
      dueAt: null,
      url: "https://github.com/tannerpolley/t3code/milestone/1",
      openCount: 3,
      closedCount: 0,
    },
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    commentCount: 0,
  });
  const provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
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
  };
  const fixture = (
    options: {
      inventoryComplete?: () => boolean;
      providerAvailable?: () => boolean;
      continuation?: boolean;
      inventoryIssues?: () => number[];
    } = {},
  ) => {
    const reads = Layer.mock(IssueService.IssueService)({
      workRead: (input) =>
        Effect.succeed({
          issue: linked(input.number),
          state: "open" as const,
          milestoneNumber: 1,
          parent: input.number === 2 ? linked(1) : null,
          subIssues: input.number === 1 ? [linked(2)] : [],
          blockedBy: [],
          parentComplete: true,
          subIssuesComplete: true,
          blockersComplete: true,
        }),
      milestoneIssues: () =>
        Effect.succeed({
          issues: (options.inventoryIssues?.() ?? [1, 2, 9]).map(summary),
          complete: options.inventoryComplete?.() ?? true,
        }),
    });
    const handoffAdapter = {
      ...adapter,
      getCapabilities: () =>
        options.providerAvailable?.() === false
          ? Effect.fail(new ProviderAdapterCapabilitiesError({ driver: adapter.driver }))
          : Effect.succeed(CodexProviderCapabilitiesV2),
    };
    const harness = makeHarness({
      providers: [provider],
      adapters: [handoffAdapter],
      issueServiceLayer: reads,
      runContinuationWorker: options.continuation ?? false,
    });
    const dependencies = Layer.mergeAll(
      harness.layer,
      reads,
      NodeCrypto.layer,
      IdAllocator.layer,
      ProviderAdapterRegistry.makeLayer([handoffAdapter]),
      IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
      EventStore.layer.pipe(Layer.provide(harness.layer)),
      ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    );
    const service = IssueWorkService.layer.pipe(Layer.provideMerge(dependencies));
    return Layer.mergeAll(
      service,
      OrchestratorMcp.layer.pipe(Layer.provide(service)),
      ProjectionMaintenance.layer.pipe(Layer.provide(dependencies)),
    );
  };
  const createRoot = Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: config.launchCommandId,
      threadId: rootId,
      projectId,
      title: "Repository orchestrator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      repositoryOrchestration: config,
      createdBy: "user",
      creationSource: "web",
    });
  });
  const scope = (threadId: ThreadId): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:handoff"),
    requestNamespace: "handoff",
    thread: {
      threadId,
      providerSessionId: "handoff-session",
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const finish = (threadId: ThreadId, key: string) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.findLast((entry) =>
        ["starting", "running", "waiting"].includes(entry.status),
      )!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${key}:result`),
            type: "message.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: MessageId.make(`${key}:result`),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              role: "assistant",
              text: `Finished ${key}. Evidence retained.`,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          },
          {
            id: EventId.make(`${key}:finish`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
    });
  const awaitFollowup = (threadId: ThreadId, afterSequence: number) =>
    EventSink.EventSinkV2.use((sink) =>
      sink.stream({ afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            (stored.event.type === "run.updated" || stored.event.type === "run.created") &&
            stored.event.threadId === threadId &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    );

  it.effect(
    "only one concurrent revision wins, installs inventory first, and retains ownership/history through compacted rebuild",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRoot;
        const results = yield* Effect.all(
          ["one", "two"].map((key) =>
            service
              .handoff({
                ...reference,
                action: "approve",
                expectedRevision: 1,
                summary: `Continue approved decisions ${key}.`,
                clientRequestId: CommandId.make(`handoff:${key}`),
              })
              .pipe(Effect.result),
          ),
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        const first = yield* service.repositoryStatus(reference);
        assert.notEqual(first.rootThreadId, rootId);
        assert.deepEqual(
          first.orchestration!.handoffHistory?.map((entry) => entry.threadId),
          [rootId],
        );
        const firstThread = yield* threads.getThreadRecords(first.rootThreadId!, ["messages"]);
        assert.include(firstThread.messages[0]!.text, "Server recovery inventory:");
        assert.include(firstThread.messages[0]!.text, "Milestones:");
        assert.include(firstThread.messages[0]!.text, "#9 Issue 9");
        assert.include(firstThread.messages[0]!.text, "Pending changes:");
        assert.equal(firstThread.messages.filter((message) => message.role === "user").length, 1);
        const retired = yield* threads
          .dispatch({
            type: "issue.work.start",
            commandId: CommandId.make("retired:start"),
            threadId: rootId,
            issue: linked(9),
            workerModelSelection: modelSelection,
            workspace: "project",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.result);
        assert.equal(retired._tag, "Failure");
        if (retired._tag === "Failure") assert.include(retired.failure.message, "retired");
        yield* finish(first.rootThreadId!, "first-root-closeout");
        const second = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: first.orchestration!.revision,
          summary: "Continue with the retained repository decisions.",
          clientRequestId: CommandId.make("handoff:second-generation"),
        });
        assert.notEqual(second.rootThreadId, first.rootThreadId);
        yield* finish(second.rootThreadId!, "second-root-closeout");
        const paused = yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("latest-root-pause"),
        });
        // These later complete-state events supersede the transfer metadata during compaction.
        for (const threadId of [rootId, first.rootThreadId!, second.rootThreadId!])
          yield* threads.dispatch({
            type: "thread.archive",
            threadId,
            commandId: CommandId.make(`archive:${threadId}`),
          });
        yield* threads.dispatch({
          type: "thread.unarchive",
          threadId: second.rootThreadId!,
          commandId: CommandId.make("restore-latest-root"),
        });
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        const rebuilt = yield* service.repositoryStatus(reference);
        assert.equal(rebuilt.rootThreadId, second.rootThreadId);
        assert.equal(rebuilt.orchestration!.revision, paused.orchestration!.revision);
        assert.isTrue(rebuilt.orchestration!.paused);
        assert.deepEqual(
          rebuilt.orchestration!.handoffHistory?.map((entry) => entry.threadId),
          [rootId, first.rootThreadId],
        );
        assert.equal((yield* store.configuration(rootId))!.retiredToThreadId, first.rootThreadId);
        assert.equal(
          (yield* store.configuration(first.rootThreadId!))!.retiredToThreadId,
          second.rootThreadId,
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "waits for nested workers and their final deliveries, keeps lineage, rejects retired MCP calls and guards archive/delete",
    () => {
      let githubIssues: number[] = [];
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const sink = yield* EventSink.EventSinkV2;
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("root:start"),
          threadId: rootId,
          messageId: MessageId.make("root:start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const delegate = (threadId: ThreadId, number: number) =>
          Effect.gen(function* () {
            const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
            const result = yield* threads.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make(`delegate:${number}`),
              parentThreadId: threadId,
              parentRunId: run.id,
              parentNodeId: run.rootNodeId!,
              issue: linked(number),
              task: `Finish issue ${number}`,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            });
            const created = result.storedEvents.find(
              (stored) => stored.event.type === "thread.created",
            )!;
            return created.event.threadId;
          });
        const parent = yield* delegate(rootId, 1);
        const child = yield* delegate(parent, 2);
        yield* service.reconcile(rootId);
        const revision = (yield* service.repositoryStatus(reference)).orchestration!.revision;
        const pending = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: revision,
          summary: "Retain nested issue outcomes and continue issue 9.",
          clientRequestId: CommandId.make("handoff:nested"),
        });
        githubIssues = [1, 2, 9];
        assert.equal(pending.rootThreadId, rootId);
        assert.equal(pending.orchestration!.handoff?.status, "draining");
        const nextId = pending.orchestration!.handoff!.nextThreadId;
        assert.isNull(yield* threads.getThreadShell(nextId));
        for (const type of ["thread.archive", "thread.delete"] as const) {
          const blocked = yield* threads
            .dispatch({ type, threadId: rootId, commandId: CommandId.make(`blocked:${type}`) })
            .pipe(Effect.result);
          assert.equal(blocked._tag, "Failure");
          if (blocked._tag === "Failure") assert.match(blocked.failure.message, /hand.?off/i);
        }
        yield* finish(rootId, "root-waits");
        yield* finish(parent, "parent-waits");
        const beforeChild = yield* sink.latestSequence();
        yield* finish(child, "nested-child");
        yield* awaitFollowup(parent, beforeChild);
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        const beforeParent = yield* sink.latestSequence();
        yield* finish(parent, "parent-delivery");
        yield* awaitFollowup(rootId, beforeParent);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        const beforeRoot = yield* sink.latestSequence();
        yield* finish(rootId, "root-delivery");
        yield* sink.stream({ afterSequence: beforeRoot, eventType: "thread.created" }).pipe(
          Stream.filter((stored) => stored.event.threadId === nextId),
          Stream.take(1),
          Stream.runDrain,
        );
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        assert.equal(
          (yield* threads.getThreadRecords(child, [])).thread.lineage.parentThreadId,
          parent,
        );
        assert.equal(
          (yield* threads.getThreadRecords(parent, [])).thread.lineage.rootThreadId,
          rootId,
        );
        const inventory = (yield* threads.getThreadRecords(nextId, ["messages"])).messages[0]!.text;
        assert.include(inventory, "Completed attempts:");
        assert.include(inventory, "Evidence retained.");
        assert.include(inventory, "#9 Issue 9");
        const milestone = yield* mcp
          .workMilestone(scope(rootId), {
            ...reference,
            projectId,
            modelRoleId: "worker",
            workspace: "project",
            milestoneNumber: 1,
            clientRequestId: CommandId.make("retired:milestone"),
          })
          .pipe(Effect.result);
        assert.equal(milestone._tag, "Failure");
        if (milestone._tag === "Failure") assert.include(milestone.failure.message, "retired");
        const delegation = yield* mcp
          .delegateTask(scope(rootId), {
            issue: { ...reference, number: 9 },
            task: "Try to delegate after retirement",
            mode: "async",
            clientRequestId: "retired:delegate",
          })
          .pipe(Effect.result);
        assert.equal(delegation._tag, "Failure");
        if (delegation._tag === "Failure") assert.include(delegation.failure.message, "retired");
        const authority = yield* service.assertCurrentCaller(parent).pipe(Effect.result);
        assert.equal(authority._tag, "Failure");
        if (authority._tag === "Failure") assert.equal(authority.failure.code, "retired-root");
        // Retired roots and their descendants cannot create, change or delete repository schedules.
        const scheduledTaskId = ScheduledTaskId.make("retired:schedule");
        for (const caller of [rootId, parent]) {
          for (const attempt of [
            mcp.scheduleTask(scope(caller), {
              prompt: "Check repository progress",
              schedule: { type: "interval", everyMs: 3_600_000 },
            }),
            mcp.updateScheduledTask(scope(caller), { scheduledTaskId, enabled: false }),
            mcp.deleteScheduledTask(scope(caller), { scheduledTaskId }),
          ]) {
            const scheduled = yield* attempt.pipe(Effect.result);
            assert.equal(scheduled._tag, "Failure");
            if (scheduled._tag === "Failure") assert.include(scheduled.failure.message, "retired");
          }
        }
      }).pipe(Effect.provide(fixture({ continuation: true, inventoryIssues: () => githubIssues })));
    },
  );

  it.effect(
    "MCP requests require exact user approval and can be cancelled without moving ownership",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createRoot;
        const input = {
          ...reference,
          expectedRevision: 1,
          summary: "Decisions to preserve.",
          clientRequestId: CommandId.make("handoff:proposal"),
        };
        const proposed = yield* mcp.requestRepositoryHandoff(scope(rootId), input);
        assert.equal(proposed.orchestration!.handoff?.status, "awaiting_approval");
        assert.isFalse(proposed.orchestration!.paused);
        assert.isNull(yield* threads.getThreadShell(proposed.orchestration!.handoff!.nextThreadId));
        const stale = yield* service
          .handoff({
            ...input,
            action: "approve",
            expectedRevision: proposed.orchestration!.revision,
            summary: "A different proposal",
            clientRequestId: CommandId.make("handoff:wrong-approval"),
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        const paused = yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("handoff:pause-before-approval"),
        });
        const approved = yield* service.handoff({
          ...input,
          action: "approve",
          expectedRevision: paused.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:user-approved"),
        });
        assert.notEqual(approved.rootThreadId, rootId);
        assert.isTrue(approved.orchestration!.paused);
        const nextProposal = yield* mcp.requestRepositoryHandoff(scope(approved.rootThreadId!), {
          ...input,
          expectedRevision: approved.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:next-proposal"),
        });
        const cancelled = yield* service.handoff({
          ...reference,
          action: "cancel",
          expectedRevision: nextProposal.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:cancel"),
        });
        assert.equal(cancelled.rootThreadId, approved.rootThreadId);
        assert.isUndefined(cancelled.orchestration!.handoff);
        assert.isTrue(cancelled.orchestration!.paused);
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "retries incomplete inventory and rejected transfer attempts until the first prompt is committed",
    () => {
      let complete = false;
      let available = false;
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRoot;
        const failed = yield* service
          .handoff({
            ...reference,
            action: "approve",
            expectedRevision: 1,
            summary: "Recover this handoff after access returns.",
            clientRequestId: CommandId.make("handoff:recovery"),
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const waiting = yield* service.repositoryStatus(reference);
        const nextId = waiting.orchestration!.handoff!.nextThreadId;
        assert.include(yield* store.activeRoots(), rootId);
        assert.equal(waiting.rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        complete = true;
        assert.equal((yield* service.reconcile(rootId).pipe(Effect.result))._tag, "Failure");
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        available = true;
        yield* service.reconcile(rootId);
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        const messages = (yield* threads.getThreadRecords(nextId, ["messages"])).messages;
        assert.equal(messages.length, 1);
        assert.include(messages[0]!.text, "Recover this handoff after access returns.");
        assert.include(messages[0]!.text, "Server recovery inventory:");
      }).pipe(
        Effect.provide(
          fixture({ inventoryComplete: () => complete, providerAvailable: () => available }),
        ),
      );
    },
  );

  it.effect(
    "keeps a handoff draining while a restart continuation is pending and drops it after retirement",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart:root-start"),
          threadId: rootId,
          messageId: MessageId.make("restart:root-start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const cut = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
        const now = yield* DateTime.now;
        // What startup recovery commits: the cut run is cancelled and its continuation queued.
        yield* sink.writeWithEffects({
          events: [
            {
              id: EventId.make("restart:cancel-cut-run"),
              type: "run.updated",
              threadId: rootId,
              runId: cut.id,
              occurredAt: now,
              payload: { ...cut, status: "cancelled", completedAt: now },
            },
          ],
          effects: [
            {
              id: `effect:restart-continuation:${cut.id}`,
              commandId: CommandId.make("restart:recovery"),
              threadId: rootId,
              request: { type: "provider-runtime.continue", sourceRunId: cut.id },
            },
          ],
        });
        const draining = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Continue after the restart.",
          clientRequestId: CommandId.make("handoff:restart"),
        });
        const nextId = draining.orchestration!.handoff!.nextThreadId;
        assert.equal(draining.rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));

        yield* outbox.cancelUnsettled({
          threadId: rootId,
          effectTypes: ["provider-runtime.continue"],
          reason: "The continuation settled.",
        });
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        // A continuation that reaches dispatch after retirement is accepted as a no-op.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:restart-continuation:${cut.id}`),
          threadId: rootId,
          messageId: MessageId.make(`message:restart-continuation:${cut.id}`),
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          restartContinuationOfRunId: cut.id,
        });
        const root = yield* threads.getThreadRecords(rootId, ["runs"]);
        assert.deepEqual(
          root.runs.map((run) => run.id),
          [cut.id],
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect("resends a scheduled prompt to the new owner when a handoff commits mid-dispatch", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      yield* createRoot;
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "handoff-schedule",
        title: "Repository check-in",
        prompt: "Review repository progress",
        enabled: 0,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: projectId,
        thread_id: null,
        repository_target_json: '{"host":"github.com","repositoryId":"repo:handoff"}',
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: JSON.stringify(modelSelection),
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: "2026-10-05T00:00:00.000Z",
        updated_at: "2026-10-05T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      const reached = yield* Deferred.make<ThreadId>();
      const release = yield* Deferred.make<void>();
      let gated = true;
      // Holds the first send after the owner was resolved, so the handoff commits in between.
      const gatedThreads = Layer.succeed(ThreadManagement.ThreadManagementService, {
        ...threads,
        sendToThread: (input) =>
          gated
            ? ((gated = false),
              Deferred.succeed(reached, input.threadId).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(threads.sendToThread(input)),
              ))
            : threads.sendToThread(input),
      });
      const result = yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const fiber = yield* tasks
          .runNow({ id: ScheduledTaskId.make("handoff-schedule") })
          .pipe(Effect.forkChild);
        assert.equal(yield* Deferred.await(reached), rootId);
        const moved = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Take over scheduled check-ins.",
          clientRequestId: CommandId.make("handoff:schedule"),
        });
        assert.notEqual(moved.rootThreadId, rootId);
        yield* Deferred.succeed(release, undefined);
        return { run: yield* Fiber.join(fiber), nextId: moved.rootThreadId! };
      }).pipe(
        Effect.provide(
          ScheduledTasks.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                gatedThreads,
                Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
              ),
            ),
          ),
        ),
      );
      assert.equal(result.run.task.lastRunStatus, "succeeded");
      const scheduled = (
        threadId: ThreadId,
      ) =>
        threads
          .getThreadRecords(threadId, ["messages"])
          .pipe(
            Effect.map((records) =>
              records.messages.filter((message) => message.scheduledTaskId !== undefined),
            ),
          );
      assert.lengthOf(yield* scheduled(rootId), 0);
      assert.lengthOf(yield* scheduled(result.nextId), 1);
    }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "routes a remaining sub-issue through a successor parent attempt under the new root",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const delegate = (threadId: ThreadId, number: number, key: string) =>
          Effect.gen(function* () {
            const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.findLast(
              (entry) => ["starting", "running", "waiting"].includes(entry.status),
            )!;
            const result = yield* threads.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make(`successor:${key}`),
              parentThreadId: threadId,
              parentRunId: run.id,
              parentNodeId: run.rootNodeId!,
              issue: linked(number),
              task: `Finish issue ${number}`,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            });
            return result.storedEvents.find((stored) => stored.event.type === "thread.created")!
              .event.threadId;
          });
        const texts = (threadId: ThreadId) =>
          threads
            .getThreadRecords(threadId, ["messages"])
            .pipe(Effect.map((records) => records.messages.map((message) => message.text)));
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("successor:root-start"),
          threadId: rootId,
          messageId: MessageId.make("successor:root-start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        // Parent issue #1 finishes under the old root; its sub-issue #2 is still open.
        const oldParent = yield* delegate(rootId, 1, "old-parent");
        yield* finish(rootId, "successor-root-waits");
        const beforeParent = yield* sink.latestSequence();
        yield* finish(oldParent, "successor-old-parent");
        yield* awaitFollowup(rootId, beforeParent);
        yield* finish(rootId, "successor-root-delivery");
        const moved = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Continue the remaining sub-issue.",
          clientRequestId: CommandId.make("handoff:successor"),
        });
        const nextId = moved.rootThreadId!;
        assert.notEqual(nextId, rootId);
        const oldParentMessages = (yield* texts(oldParent)).length;

        yield* threads.dispatch({
          type: "issue.work.start",
          commandId: CommandId.make("successor:start-sub-issue"),
          threadId: nextId,
          issue: linked(2),
          workerModelSelection: modelSelection,
          workspace: "project",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* service.reconcile(nextId);
        assert.lengthOf(yield* texts(oldParent), oldParentMessages);
        assert.isTrue((yield* texts(nextId)).some((text) => text.startsWith("Start issue #1")));

        const newParent = yield* delegate(nextId, 1, "new-parent");
        yield* service.reconcile(nextId);
        assert.isTrue(
          (yield* texts(newParent)).some((text) =>
            text.startsWith("Start your authorized sub-issue #2"),
          ),
        );
        assert.lengthOf(yield* texts(oldParent), oldParentMessages);
        assert.equal(
          (yield* threads.getThreadRecords(oldParent, [])).thread.lineage.rootThreadId,
          rootId,
        );
      }).pipe(Effect.provide(fixture({ continuation: true, inventoryIssues: () => [] }))),
  );
});
