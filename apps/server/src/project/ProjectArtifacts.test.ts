import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectArtifact, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { HandlersLayer } from "../mcp/McpToolAccess.ts";
import * as ArtifactHandlers from "../mcp/toolkits/projectArtifacts/handlers.ts";
import { ProjectArtifactsToolkit } from "../mcp/toolkits/projectArtifacts/tools.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { KnownWorkspaces } from "../workspace/KnownWorkspaces.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ProjectArtifacts, layer } from "./ProjectArtifacts.ts";

const dependencies = Layer.mergeAll(
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(Layer.mock(KnownWorkspaces)({})),
    Layer.provide(Layer.mock(WorkspaceEntries)({})),
  ),
  ProjectStore.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-artifacts-test-" })),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const isProjectArtifact = Schema.is(ProjectArtifact);

const caller = Layer.merge(
  Layer.succeed(McpInvocationContext, {
    environmentId: EnvironmentId.make("test"),
    requestNamespace: "client:artifacts",
    thread: undefined,
    client: { sessionId: "artifacts", label: "Artifacts test", access: "full-access" },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
  Layer.mock(ThreadManagementService)({}),
);

it.effect("streams MCP changes to one project and keeps pins across service restarts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const report = path.join(yield* fs.realPath(root), "report.pdf");
    yield* fs.writeFileString(report, "report");
    const projectId = ProjectId.make("research");
    const otherProjectId = ProjectId.make("other");
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Research', ${root}, '[]', '2026-01-01', '2026-01-01'),
             (${otherProjectId}, 'Other', ${root}, '[]', '2026-01-01', '2026-01-01')
    `;
    const artifact = yield* Effect.gen(function* () {
      const artifacts = yield* ProjectArtifacts;
      const connected = yield* Deferred.make<void>();
      const updates = yield* artifacts.subscribe(projectId).pipe(
        Stream.tap(() => Deferred.succeed(connected, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);

      const tools = yield* ProjectArtifactsToolkit.pipe(
        Effect.provide(HandlersLayer.layer(ArtifactHandlers.layer)),
      );
      const [add] = yield* tools
        .handle("t3_project_artifacts_add", {
          projectId,
          path: "report.pdf",
          label: "Report",
          description: "A finished report",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      if (!add || !isProjectArtifact(add.result))
        return yield* Effect.die(add?.result ?? "No artifact result");
      const pin = add.result;
      expect(yield* Fiber.join(updates)).toEqual([[], [pin]]);
      expect(pin.path).toBe(report);
      expect(yield* artifacts.list(otherProjectId)).toEqual([]);
      expect(yield* artifacts.add({ projectId, path: report, label: "Duplicate" }, "user")).toEqual(
        pin,
      );

      const [update] = yield* tools
        .handle("t3_project_artifacts_update", {
          projectId,
          id: pin.id,
          label: "Final report",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(update?.isFailure).toBe(false);
      const [listing] = yield* tools
        .handle("t3_project_artifacts_list", { projectId })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(listing?.result).toEqual([{ ...pin, label: "Final report" }]);
      const directory = yield* artifacts.add({ projectId, path: root }, "user").pipe(Effect.flip);
      expect(directory.reason).toBe("invalid-file");
      return { ...pin, label: "Final report" };
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layer), caller)));

    yield* Effect.gen(function* () {
      const artifacts = yield* ProjectArtifacts;
      expect(yield* artifacts.list(projectId)).toEqual([artifact]);
      yield* artifacts.remove({ projectId: otherProjectId, id: artifact.id });
      expect(yield* artifacts.list(projectId)).toEqual([artifact]);

      const tools = yield* ProjectArtifactsToolkit.pipe(
        Effect.provide(HandlersLayer.layer(ArtifactHandlers.layer)),
      );
      const [remove] = yield* tools
        .handle("t3_project_artifacts_remove", { projectId, id: artifact.id })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(remove?.isFailure).toBe(false);
      expect(yield* artifacts.list(projectId)).toEqual([]);
      expect(yield* fs.readFileString(report)).toBe("report");
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layer), caller)));
  }).pipe(Effect.provide(dependencies)),
);
