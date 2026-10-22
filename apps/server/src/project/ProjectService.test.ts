import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedFolders from "./ManagedProjectFolders.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as SidebarLayout from "../sidebarLayout.ts";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const layerMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `github.com/t3tools/${workspaceRoot.split("/").at(-1)}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@github.com:t3tools/${workspaceRoot.split("/").at(-1)}.git`,
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    invalidate: () => Effect.void,
    resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
  }),
);

const layerTestFor = (
  projectMetadataLayer: Layer.Layer<
    | ProjectFaviconResolver.ProjectFaviconResolver
    | RepositoryIdentityResolver.RepositoryIdentityResolver
  >,
  projectSettingsFolded = false,
) =>
  RuntimeLayer.layerProjectService.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(projectMetadataLayer),
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({ projectSettingsFolded })),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const layerTest = layerTestFor(layerMetadata);

const layerProjectServiceDependencies = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  CommandReceiptStore.layer,
  ProjectStore.layer,
  ProjectionStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(LegacyV1ThreadImporter.layer.pipe(Layer.provide(RuntimeLayer.layerEventSink))),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerMetadata),
  Layer.provideMerge(SidebarLayout.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-service-race-" })),
  Layer.provide(NodeServices.layer),
);

const waitForProject = Effect.fn("ProjectServiceTest.waitForProject")(function* (
  service: ProjectService.ProjectService["Service"],
  projectId: ProjectId,
  predicate: (project: Project) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const project = Option.getOrThrow(yield* service.getById(projectId));
    if (predicate(project)) return project;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Project ${projectId} was not enriched in time.`);
});

it.layer(layerTest)("ProjectService", (it) => {
  it.effect(
    "MCP project scripts use folded settings for create, update, reads, and clearing while preserving sidebar placement",
    () =>
      Effect.gen(function* () {
        const service = yield* ProjectService.ProjectService;
        const sidebar = yield* SidebarLayout.SidebarLayoutService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const store = yield* ProjectStore.ProjectStoreV2;
        const scripts = [
          {
            id: "check-status",
            name: "Check status",
            command: "echo status",
            icon: "play" as const,
            runOnWorktreeCreate: true,
            runOnSettle: true,
            async: true,
            autoOpenPreview: true,
          },
        ];
        const defaults = [{ ...scripts[0]!, id: "environment-default" }];
        yield* settings.updateSettings({ defaultProjectScripts: defaults });
        yield* sidebar.update({
          revision: 0,
          operations: [{ type: "add", section: { id: "mcp", name: "MCP" } }],
        });
        const threadId = ThreadId.make("mcp-caller");
        const caller = {
          id: threadId,
          projectId: ProjectId.make("caller-project"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          activeRunId: "active",
          archivedAt: null,
          deletedAt: null,
        } as OrchestrationV2ThreadShell;
        const dependencies = Layer.mergeAll(
          Layer.succeed(ProjectService.ProjectService, service),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(caller),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(ManagedFolders.ManagedProjectFolders)({ namedProjectsRoot: "/work" }),
          Layer.mock(Git.GitVcsDriver)({}),
          Layer.succeed(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("mcp-test"),
            requestNamespace: "session",
            thread: {
              threadId,
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
          NodeCrypto.layer,
        );
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            Access.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
          ),
        );
        const created = yield* toolkit
          .handle("t3_project_create", {
            title: "Agent project",
            workspaceRoot: "/work/agent-project",
            sectionId: "mcp",
            sidebarExpanded: true,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        const project = created.at(-1)?.result;
        assert.ok(project && "id" in project);
        if (!project || !("id" in project)) return;
        assert.deepEqual((yield* sidebar.get).layout.sidebarProjectSections[0]?.projectKeys, [
          project.id,
        ]);
        assert.isTrue((yield* sidebar.get).layout.projectExpandedById[project.id]);
        yield* toolkit
          .handle("t3_project_update", {
            projectId: project.id,
            sectionId: null,
            sidebarExpanded: false,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        assert.isUndefined((yield* settings.getSettings).projectSettingsOverrides[project.id]);

        const write = (input: { scripts?: typeof scripts; title?: string }) =>
          toolkit
            .handle("t3_project_update", { projectId: project.id, ...input })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        // No action override exists yet, as in the reported reproduction.
        yield* write({ scripts });
        const configured = yield* settings.getSettings;
        assert.deepEqual(configured.projectSettingsOverrides[project.id], {
          defaultProjectScripts: scripts,
        });
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [project.id]: {
              ...configured.projectSettingsOverrides[project.id],
              defaultAutoPull: true,
            },
          },
        });
        assert.deepEqual(configured.defaultProjectScripts, defaults);
        assert.deepEqual(Option.getOrThrow(yield* store.get(project.id)).scripts, []);
        const read = yield* toolkit
          .handle("t3_project_read", { projectId: project.id })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        const readProject = read.at(-1)?.result;
        assert.ok(readProject && "scripts" in readProject);
        if (!readProject || !("scripts" in readProject)) return;
        assert.deepEqual(readProject.scripts, scripts);
        const effective = Option.getOrThrow(yield* service.getById(project.id));
        assert.deepEqual(effective.scripts, scripts);
        assert.deepEqual(resolveProjectScripts(configured, effective), scripts);
        yield* write({ title: "Renamed" });
        assert.deepEqual(
          Option.getOrThrow(yield* service.getByWorkspaceRoot(project.workspaceRoot)).scripts,
          scripts,
        );
        yield* write({ scripts: [] });
        assert.deepEqual(Option.getOrThrow(yield* service.getById(project.id)).scripts, []);
        assert.deepEqual((yield* settings.getSettings).defaultProjectScripts, defaults);
        assert.deepEqual((yield* settings.getSettings).projectSettingsOverrides[project.id], {
          defaultAutoPull: true,
          defaultProjectScripts: [],
        });
        assert.deepEqual(
          (yield* service.snapshot).projects.find((row) => row.id === project.id)?.scripts,
          [],
        );
        const replayInput = {
          projectId: project.id,
          commandId: CommandId.make("folded-script-replay"),
          scripts,
        };
        yield* service.update(replayInput);
        yield* write({ scripts: [] });
        yield* service.update(replayInput);
        assert.deepEqual(Option.getOrThrow(yield* service.getById(project.id)).scripts, []);
        const invalid = yield* service
          .update({
            ...replayInput,
            commandId: CommandId.make("folded-invalid-script"),
            scripts: [{ ...scripts[0]!, id: "Not.Valid" }],
          })
          .pipe(Effect.flip);
        assert.equal(invalid._tag, "ProjectOperationError");
        assert.deepEqual(
          (yield* settings.getSettings).projectSettingsOverrides[project.id]?.defaultProjectScripts,
          [],
        );
        const createdWithScripts = yield* toolkit
          .handle("t3_project_create", {
            title: "With actions",
            workspaceRoot: "/work/with-actions",
            scripts,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        const second = createdWithScripts.at(-1)?.result;
        assert.ok(second && "id" in second);
        if (!second || !("id" in second)) return;
        assert.deepEqual(second.scripts, scripts);
        assert.deepEqual(
          (yield* settings.getSettings).projectSettingsOverrides[second.id]?.defaultProjectScripts,
          scripts,
        );
        assert.deepEqual(Option.getOrThrow(yield* store.get(second.id)).scripts, []);

        assert.deepEqual((yield* sidebar.get).layout.sidebarProjectSections[0]?.projectKeys, []);
        const rejected = yield* toolkit
          .handle("t3_project_create", {
            title: "Invalid",
            workspaceRoot: "/work/invalid-mcp",
            sectionId: "missing",
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        const rejection = rejected.at(-1)?.result;
        assert.ok(rejection && "message" in rejection);
        if (rejection && "message" in rejection)
          assert.equal(rejection.message, "Section not found.");
        assert.isTrue(Option.isNone(yield* service.getByWorkspaceRoot("/work/invalid-mcp")));
      }).pipe(Effect.provide(Layer.fresh(layerTestFor(layerMetadata, true)))),
  );
  it.effect(
    "organizes only lifecycle changes, skips empty metadata events, and deletes sidebar references",
    () =>
      Effect.gen(function* () {
        const service = yield* ProjectService.ProjectService;
        const sidebar = yield* SidebarLayout.SidebarLayoutService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const sql = yield* SqlClient.SqlClient;
        yield* settings.updateSettings({ projectFolderRoot: "/work" });
        assert.equal((yield* sidebar.get).revision, 0);
        const projectId = ProjectId.make("sidebar-lifecycle");
        yield* service.create({
          commandId: CommandId.make("lifecycle:create"),
          projectId,
          title: "Lifecycle",
          workspaceRoot: "/work/Apps/lifecycle",
          sidebarExpanded: true,
        });
        const created = yield* sidebar.get;
        assert.deepEqual(created.layout.sidebarProjectSections[0]?.projectKeys, [projectId]);
        yield* service.listShells();
        yield* service.update({
          commandId: CommandId.make("lifecycle:rename"),
          projectId,
          title: "Renamed",
        });
        assert.equal((yield* sidebar.get).revision, created.revision);
        const eventsBefore = yield* sql.unsafe("SELECT sequence FROM orchestration_events");
        yield* service.update({
          commandId: CommandId.make("lifecycle:placement"),
          projectId,
          sectionId: created.layout.sidebarProjectSections[0]!.id,
          sidebarExpanded: false,
        });
        assert.deepEqual(
          yield* sql.unsafe("SELECT sequence FROM orchestration_events"),
          eventsBefore,
        );
        yield* sidebar.update({
          revision: 0,
          operations: [
            {
              type: "projectsOrder",
              currentProjectOrder: [projectId],
              draggedProjectIds: [projectId],
              targetProjectIds: [projectId],
            },
          ],
        });
        yield* service.delete({ commandId: CommandId.make("lifecycle:delete"), projectId });
        const deleted = (yield* sidebar.get).layout;
        assert.isUndefined(deleted.projectExpandedById[projectId]);
        assert.isFalse(deleted.projectOrder.includes(projectId));
        assert.isFalse(
          deleted.sidebarProjectSections.some((section) => section.projectKeys.includes(projectId)),
        );
      }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );
  it.effect("rolls back a new project when placement persistence fails", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sidebar = yield* SidebarLayout.SidebarLayoutService;
      const sql = yield* SqlClient.SqlClient;
      yield* sidebar.update({
        revision: 0,
        operations: [{ type: "add", section: { id: "atomic", name: "Atomic" } }],
      });
      yield* sql.unsafe(
        "CREATE TRIGGER fail_sidebar BEFORE UPDATE ON sidebar_layout BEGIN SELECT RAISE(ABORT, 'placement failed'); END",
      );
      const projectId = ProjectId.make("atomic-project");
      yield* service
        .create({
          commandId: CommandId.make("atomic:create"),
          projectId,
          title: "Atomic",
          workspaceRoot: "/work/atomic",
          sectionId: "atomic",
        })
        .pipe(Effect.flip);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.equal((yield* sidebar.get).revision, 1);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );
  it.effect(
    "places and expands at creation, retains membership after repository enrichment, and supports removal",
    () =>
      Effect.gen(function* () {
        const sidebar = yield* SidebarLayout.SidebarLayoutService;
        const service = yield* ProjectService.ProjectService;
        const enrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
        const changes = yield* enrichment.subscribeChanges;
        yield* sidebar.update({
          revision: 0,
          operations: [{ type: "add", section: { id: "personal", name: "Personal" } }],
        });
        const projectId = ProjectId.make("sidebar-clone");
        const completed = yield* Stream.fromSubscription(changes).pipe(
          Stream.filter(
            (change) =>
              change.workspaceRoot === "/work/sidebar-clone" &&
              change.enrichment.repositoryIdentity !== null,
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* service.create({
          projectId,
          commandId: CommandId.make("sidebar-create"),
          title: "Clone",
          workspaceRoot: "/work/sidebar-clone",
          sectionId: "personal",
          sidebarExpanded: true,
        });
        assert.deepEqual((yield* sidebar.get).layout?.sidebarProjectSections[0]?.projectKeys, [
          projectId,
        ]);
        assert.isTrue((yield* sidebar.get).layout?.projectExpandedById[projectId]);
        yield* Fiber.join(completed);
        assert.isNotNull(Option.getOrThrow(yield* service.getById(projectId)).repositoryIdentity);
        assert.deepEqual((yield* sidebar.get).layout?.sidebarProjectSections[0]?.projectKeys, [
          projectId,
        ]);
        yield* service.update({
          projectId,
          commandId: CommandId.make("sidebar-remove"),
          sectionId: null,
          sidebarExpanded: false,
        });
        assert.deepEqual((yield* sidebar.get).layout?.sidebarProjectSections[0]?.projectKeys, []);
        assert.isFalse((yield* sidebar.get).layout?.projectExpandedById[projectId]);
        const invalid = yield* service
          .create({
            projectId: ProjectId.make("invalid-section-project"),
            commandId: CommandId.make("sidebar-invalid"),
            title: "Invalid",
            workspaceRoot: "/work/invalid",
            sectionId: "missing",
          })
          .pipe(Effect.flip);
        assert.equal(invalid._tag, "ProjectOperationError");
        assert.isTrue(
          Option.isNone(yield* service.getById(ProjectId.make("invalid-section-project"))),
        );
      }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("creates, updates, resolves, snapshots, and soft-deletes projects", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:service-test");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex_custom"),
        model: "gpt-5.1-codex",
      } as const;
      yield* TestClock.setTime(Date.parse("2026-06-20T10:00:00.000Z"));

      const created = yield* service.create({
        commandId: CommandId.make("command:project:create"),
        projectId,
        title: "Project",
        workspaceRoot: "/work/project/",
        defaultModelSelection: modelSelection,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "vp install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      });
      assert.equal(created.workspaceRoot, "/work/project");
      assert.isNull(created.repositoryIdentity);
      assert.isNull(created.faviconPath);

      const hydratedCreated = yield* waitForProject(
        service,
        projectId,
        (project) => project.repositoryIdentity !== null && project.faviconPath !== null,
      );
      assert.equal(hydratedCreated?.repositoryIdentity?.canonicalKey, "github.com/t3tools/project");
      assert.equal(hydratedCreated?.faviconPath, "/work/project/favicon.svg");

      const updated = yield* service.update({
        commandId: CommandId.make("command:project:update"),
        projectId,
        title: "Renamed",
        autoPull: true,
        projectIcon: { kind: "emoji", emoji: "🦊" },
        faviconPath: "/work/project/custom.svg",
        defaultThreadEnvMode: "worktree",
      });
      assert.equal(updated.title, "Renamed");
      assert.equal(updated.createdAt, created.createdAt);
      assert.isTrue(updated.autoPull);
      assert.deepEqual(updated.projectIcon, { kind: "emoji", emoji: "🦊" });
      assert.equal(updated.faviconPath, "/work/project/custom.svg");
      assert.equal(updated.defaultThreadEnvMode, "worktree");

      const byId = yield* service.getById(projectId);
      const byWorkspace = yield* service.getByWorkspaceRoot("/work/project/");
      assert.isTrue(Option.isSome(byId));
      assert.isTrue(Option.isSome(byWorkspace));
      assert.equal(Option.getOrThrow(byWorkspace).id, projectId);
      assert.isTrue(Option.getOrThrow(byId).autoPull);
      assert.deepEqual(Option.getOrThrow(byId).projectIcon, updated.projectIcon);
      assert.equal(Option.getOrThrow(byId).faviconPath, updated.faviconPath);
      assert.equal(Option.getOrThrow(byId).defaultThreadEnvMode, "worktree");
      const reset = yield* service.update({
        commandId: CommandId.make("command:project:reset-appearance"),
        projectId,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
      });
      assert.isFalse(reset.autoPull);
      assert.isNull(reset.projectIcon);
      assert.equal(reset.faviconPath, hydratedCreated.faviconPath);
      assert.isNull(reset.defaultThreadEnvMode);
      assert.deepEqual(
        (yield* service.snapshot).projects.map((project) => project.id),
        [projectId],
      );

      const deleted = yield* service.delete({
        commandId: CommandId.make("command:project:delete"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.isTrue(Option.isSome(yield* service.getById(projectId, { includeDeleted: true })));
      assert.deepEqual((yield* service.snapshot).projects, []);

      const sql = yield* SqlClient.SqlClient;
      const changes = yield* sql<{ readonly event_type: string }>`
        SELECT event_type
        FROM orchestration_events
        WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        changes.map((change) => change.event_type),
        ["project.created", "project.meta-updated", "project.meta-updated", "project.deleted"],
      );
    }),
  );

  it.effect("auto-bootstraps a workspace exactly once", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      yield* TestClock.setTime(Date.parse("2026-06-20T10:00:00.000Z"));
      const input = {
        commandId: CommandId.make("command:bootstrap:first"),
        projectId: ProjectId.make("project:bootstrap"),
        title: "Bootstrap",
        workspaceRoot: "/work/bootstrap/",
      };
      const first = yield* service.bootstrap(input);
      const second = yield* service.bootstrap({
        ...input,
        commandId: CommandId.make("command:bootstrap:second"),
        projectId: ProjectId.make("project:bootstrap:unused"),
      });
      assert.isTrue(first.created);
      assert.isFalse(second.created);
      assert.equal(second.project.id, first.project.id);
    }),
  );

  it.effect("commits the event, the row and the receipt together, once per command id", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:retry");
      const input = {
        commandId: CommandId.make("command:retry:create"),
        projectId,
        title: "Retry",
        workspaceRoot: "/work/retry",
      };
      const first = yield* service.create(input);
      const retried = yield* service.create(input);
      assert.deepEqual(retried, first);
      const updateInput = {
        commandId: CommandId.make("command:retry:update"),
        projectId,
        autoPull: true,
      };
      yield* service.update(updateInput);
      yield* service.update(updateInput);

      const committed = yield* sql<{
        readonly sequence: number;
        readonly event_type: string;
        readonly receipt_sequence: number;
        readonly status: string;
        readonly aggregate_kind: string;
      }>`
        SELECT events.sequence, events.event_type,
          receipts.result_sequence AS receipt_sequence, receipts.status, receipts.aggregate_kind
        FROM orchestration_events AS events
        JOIN orchestration_command_receipts AS receipts ON receipts.command_id = events.command_id
        WHERE events.stream_id = ${projectId}
        ORDER BY events.sequence
      `;
      assert.deepEqual(
        committed.map((row) => [row.event_type, row.status, row.aggregate_kind]),
        [
          ["project.created", "accepted", "project"],
          ["project.meta-updated", "accepted", "project"],
        ],
      );
      for (const row of committed) assert.equal(row.receipt_sequence, row.sequence);
      assert.isTrue(Option.getOrThrow(yield* service.getById(projectId)).autoPull);
    }),
  );

  it.effect("replays a rejected receipt instead of re-planning the command", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:rejected");
      yield* service.create({
        commandId: CommandId.make("command:rejected:create"),
        projectId,
        title: "Rejected",
        workspaceRoot: "/work/rejected",
      });
      const invalid = {
        commandId: CommandId.make("command:rejected:script"),
        projectId,
        scripts: [
          {
            id: "Not.Valid",
            name: "Invalid",
            command: "true",
            icon: "play" as const,
            runOnWorktreeCreate: false,
          },
        ],
      };
      const first = yield* service.update(invalid).pipe(Effect.flip);
      assert.equal(first._tag, "ProjectOperationError");
      const replayed = yield* service
        .update({ ...invalid, scripts: [{ ...invalid.scripts[0]!, id: "valid" }] })
        .pipe(Effect.flip);
      assert.equal(replayed._tag, "ProjectOperationError");
      assert.include(
        String(replayed._tag === "ProjectOperationError" && replayed.cause),
        "Script ID",
      );
      const receipts = yield* sql<{ readonly status: string; readonly aggregate_id: string }>`
        SELECT status, aggregate_id FROM orchestration_command_receipts
        WHERE command_id = ${invalid.commandId}
      `;
      assert.deepEqual(receipts, [{ status: "rejected", aggregate_id: projectId }]);
      const events = yield* sql`
        SELECT sequence FROM orchestration_events WHERE command_id = ${invalid.commandId}
      `;
      assert.deepEqual(events, []);
      assert.deepEqual(Option.getOrThrow(yield* service.getById(projectId)).scripts, []);
    }),
  );

  it.effect("rejects a workspace another active project holds", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const other = ProjectId.make("project:conflict:mover");
      yield* service.create({
        commandId: CommandId.make("command:conflict:holder"),
        projectId: ProjectId.make("project:conflict:holder"),
        title: "Holder",
        workspaceRoot: "/work/conflict",
      });
      yield* service.create({
        commandId: CommandId.make("command:conflict:mover"),
        projectId: other,
        title: "Mover",
        workspaceRoot: "/work/conflict-mover",
      });
      const move = yield* service
        .update({
          commandId: CommandId.make("command:conflict:move"),
          projectId: other,
          workspaceRoot: "/work/conflict",
        })
        .pipe(Effect.flip);
      assert.equal(move._tag, "ProjectConflictError");
      assert.equal(
        Option.getOrThrow(yield* service.getById(other)).workspaceRoot,
        "/work/conflict-mover",
      );
    }),
  );

  it.effect("replays a workspace conflict after the workspace frees up", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const holderId = ProjectId.make("project:freed:holder");
      yield* service.create({
        commandId: CommandId.make("command:freed:holder"),
        projectId: holderId,
        title: "Holder",
        workspaceRoot: "/work/freed",
      });
      const claim = {
        commandId: CommandId.make("command:freed:claim"),
        projectId: ProjectId.make("project:freed:claim"),
        title: "Claim",
        workspaceRoot: "/work/freed",
      };
      const first = yield* service.create(claim).pipe(Effect.flip);
      yield* service.delete({
        commandId: CommandId.make("command:freed:delete"),
        projectId: holderId,
      });
      const replayed = yield* service.create(claim).pipe(Effect.flip);
      assert.deepEqual(replayed, first);
      assert.instanceOf(replayed, ProjectService.ProjectConflictError);
      assert.isTrue(
        Option.isNone(yield* service.getById(claim.projectId, { includeDeleted: true })),
      );
    }),
  );

  it.effect("returns the deleted project when a completed delete is retried", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:delete-retry");
      yield* service.create({
        commandId: CommandId.make("command:delete-retry:create"),
        projectId,
        title: "Delete retry",
        workspaceRoot: "/work/delete-retry",
      });
      const input = { commandId: CommandId.make("command:delete-retry:delete"), projectId };
      const deleted = yield* service.delete(input);
      assert.deepEqual(yield* service.delete(input), deleted);
      const events = yield* sql<{ readonly command_id: string }>`
        SELECT command_id FROM orchestration_events
        WHERE stream_id = ${projectId} AND event_type = 'project.deleted'
      `;
      assert.deepEqual(events, [{ command_id: input.commandId }]);
    }),
  );

  it.effect("treats a deleted project as missing for updates and new deletes", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:deleted-target");
      yield* service.create({
        commandId: CommandId.make("command:deleted-target:create"),
        projectId,
        title: "Deleted target",
        workspaceRoot: "/work/deleted-target",
      });
      yield* service.delete({
        commandId: CommandId.make("command:deleted-target:delete"),
        projectId,
      });
      const again = yield* service
        .delete({ commandId: CommandId.make("command:deleted-target:delete-again"), projectId })
        .pipe(Effect.flip);
      assert.instanceOf(again, ProjectService.ProjectNotFoundError);
      const events = yield* sql<{ readonly event_type: string }>`
        SELECT event_type FROM orchestration_events
        WHERE stream_id = ${projectId} ORDER BY sequence ASC
      `;
      assert.deepEqual(
        events.map((event) => event.event_type),
        ["project.created", "project.deleted"],
      );
    }),
  );

  it.effect("rolls back the event and receipt when the row write fails", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:atomic");
      yield* sql`
        CREATE TRIGGER fail_project_row BEFORE INSERT ON projection_projects
        WHEN NEW.project_id = 'project:atomic'
        BEGIN SELECT RAISE(ABORT, 'injected row failure'); END
      `;
      const input = {
        commandId: CommandId.make("command:atomic:create"),
        projectId,
        title: "Atomic",
        workspaceRoot: "/work/atomic",
      };
      const failure = yield* service.create(input).pipe(Effect.flip);
      assert.equal(failure._tag, "ProjectOperationError");
      const leftovers = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events WHERE command_id = ${input.commandId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = ${input.commandId}) +
          (SELECT COUNT(*) FROM projection_projects WHERE project_id = ${projectId}) AS count
      `;
      assert.equal(leftovers[0]?.count, 0);
      yield* sql`DROP TRIGGER fail_project_row`;
      assert.equal((yield* service.create(input)).id, projectId);
    }),
  );
});

it.effect("keeps project snapshots available when optional metadata enrichment fails", () =>
  Effect.gen(function* () {
    const layerFailingMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) =>
          Effect.fail(
            new ProjectFaviconResolver.ProjectFaviconResolutionError({
              operation: "stat-candidate",
              workspaceRoot,
              cause: "permission denied",
            }),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:failed-enrichment");
      yield* service.create({
        commandId: CommandId.make("command:failed-enrichment:create"),
        projectId,
        title: "Still visible",
        workspaceRoot: "/work/failed-enrichment",
      });

      const snapshot = yield* service.snapshot;
      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.id, projectId);
      assert.equal(snapshot.projects[0]?.title, "Still visible");
      assert.isNull(snapshot.projects[0]?.repositoryIdentity ?? null);
      assert.isNull(snapshot.projects[0]?.faviconPath ?? null);
    }).pipe(Effect.provide(layerTestFor(layerFailingMetadata)));
  }),
);

it.effect("invalidates workspace-derived metadata when a project moves", () =>
  Effect.gen(function* () {
    const metadataVersion = yield* Ref.make(1);
    const layerVersionedMetadata = Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: (workspaceRoot) =>
          Ref.get(metadataVersion).pipe(
            Effect.map((version) => ({
              canonicalKey: `example.test/v${version}${workspaceRoot}`,
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: `https://example.test/v${version}${workspaceRoot}.git`,
              },
              rootPath: workspaceRoot,
            })),
          ),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: (workspaceRoot) =>
          Ref.get(metadataVersion).pipe(
            Effect.map((version) => `${workspaceRoot}/favicon-v${version}.svg`),
          ),
      }),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:moved-enrichment");
      yield* service.create({
        commandId: CommandId.make("command:moved-enrichment:create"),
        projectId,
        title: "Moved",
        workspaceRoot: "/work/original",
      });
      assert.equal(
        (yield* waitForProject(
          service,
          projectId,
          (project) => project.faviconPath === "/work/original/favicon-v1.svg",
        )).faviconPath,
        "/work/original/favicon-v1.svg",
      );

      yield* Ref.set(metadataVersion, 2);
      yield* service.update({
        commandId: CommandId.make("command:moved-enrichment:away"),
        projectId,
        workspaceRoot: "/work/temporary",
      });
      yield* service.snapshot;

      yield* Ref.set(metadataVersion, 3);
      yield* service.update({
        commandId: CommandId.make("command:moved-enrichment:return"),
        projectId,
        workspaceRoot: "/work/original",
      });
      assert.equal(
        (yield* waitForProject(
          service,
          projectId,
          (project) => project.faviconPath === "/work/original/favicon-v3.svg",
        )).faviconPath,
        "/work/original/favicon-v3.svg",
      );
    }).pipe(Effect.provide(layerTestFor(layerVersionedMetadata)));
  }),
);

it.effect("serializes two projects claiming the same workspace root", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const firstReachedCommit = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const gatedSink = EventSink.EventSinkV2.of({
      ...eventSink,
      commitProjectCommand: (input) =>
        input.projectId === "project:race:first"
          ? Deferred.succeed(firstReachedCommit, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(eventSink.commitProjectCommand(input)),
            )
          : eventSink.commitProjectCommand(input),
    });
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(EventSink.EventSinkV2, gatedSink),
    );
    const claim = (name: string) =>
      service.create({
        commandId: CommandId.make(`command:race:${name}`),
        projectId: ProjectId.make(`project:race:${name}`),
        title: name,
        workspaceRoot: "/work/race",
      });
    const first = yield* claim("first").pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(firstReachedCommit);
    const second = yield* claim("second").pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    assert.isUndefined(second.pollUnsafe());
    yield* Deferred.succeed(releaseFirst, undefined);
    assert.equal((yield* Fiber.join(first)).id, "project:race:first");
    assert.equal((yield* Fiber.join(second))._tag, "ProjectConflictError");
  }).pipe(Effect.provide(layerProjectServiceDependencies)),
);

it.effect("rejects an update that waited on the lock while its project was deleted", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const deleteReachedCommit = yield* Deferred.make<void>();
    const releaseDelete = yield* Deferred.make<void>();
    const gatedSink = EventSink.EventSinkV2.of({
      ...eventSink,
      commitProjectCommand: (input) =>
        input.commandType === "project.delete"
          ? Deferred.succeed(deleteReachedCommit, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDelete)),
              Effect.andThen(eventSink.commitProjectCommand(input)),
            )
          : eventSink.commitProjectCommand(input),
    });
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(EventSink.EventSinkV2, gatedSink),
    );
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:update-race");
    yield* service.create({
      commandId: CommandId.make("command:update-race:create"),
      projectId,
      title: "Update race",
      workspaceRoot: "/work/update-race",
    });
    const deletion = yield* service
      .delete({ commandId: CommandId.make("command:update-race:delete"), projectId })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(deleteReachedCommit);
    const updateCommandId = CommandId.make("command:update-race:update");
    const update = yield* service
      .update({ commandId: updateCommandId, projectId, title: "Too late" })
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseDelete, undefined);
    assert.isNotNull((yield* Fiber.join(deletion)).deletedAt);
    assert.instanceOf(yield* Fiber.join(update), ProjectService.ProjectNotFoundError);
    const receipts = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_command_receipts WHERE command_id = ${updateCommandId}
    `;
    assert.deepEqual(receipts, [{ status: "rejected" }]);
    const events = yield* sql<{ readonly event_type: string }>`
      SELECT event_type FROM orchestration_events
      WHERE stream_id = ${projectId} ORDER BY sequence ASC
    `;
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["project.created", "project.deleted"],
    );
    assert.equal(
      Option.getOrThrow(yield* service.getById(projectId, { includeDeleted: true })).title,
      "Update race",
    );
  }).pipe(Effect.provide(layerProjectServiceDependencies)),
);

it.effect("folded script writes let settings revalidation read SQLite under contention", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provide(ServerSettings.layerTest({ projectSettingsFolded: true })),
    );
    const settingsLock = yield* Semaphore.make(1);
    const watcherHasLock = yield* Deferred.make<void>();
    const scriptWriteStarted = yield* Deferred.make<void>();
    const reloaded = yield* Deferred.make<void>();
    const contendedSettings = ServerSettings.ServerSettingsService.of({
      ...settings,
      updateSettingsWith: (patch) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(scriptWriteStarted, undefined);
          return yield* settingsLock.withPermits(1)(settings.updateSettingsWith(patch));
        }),
    });
    const service = yield* ProjectService.make.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, contendedSettings),
    );
    const projectId = ProjectId.make("project:settings-contention");
    yield* service.create({
      projectId,
      commandId: CommandId.make("settings-contention:create"),
      title: "Settings contention",
      workspaceRoot: "/work/settings-contention",
    });
    // Revalidation owns the settings lock, then reloads database-backed provider history.
    const watcher = yield* settingsLock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* Deferred.succeed(watcherHasLock, undefined);
          yield* Deferred.await(scriptWriteStarted);
          yield* sql.withTransaction(sql`SELECT COUNT(*) FROM projection_projects`);
          yield* Deferred.succeed(reloaded, undefined);
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(watcherHasLock);
    const scripts = [
      {
        id: "status",
        name: "Status",
        command: "echo status",
        icon: "play" as const,
        runOnWorktreeCreate: false,
      },
    ];
    const update = yield* service
      .update({
        projectId,
        commandId: CommandId.make("settings-contention:update"),
        scripts,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(reloaded);
    yield* Fiber.join(watcher);
    assert.deepEqual((yield* Fiber.join(update)).scripts, scripts);
    assert.deepEqual(
      (yield* settings.getSettings).projectSettingsOverrides[projectId]?.defaultProjectScripts,
      scripts,
    );
  }).pipe(Effect.provide(layerProjectServiceDependencies)),
);
