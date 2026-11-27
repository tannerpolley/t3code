import {
  OrchestratorMcpFailure,
  type ProjectArtifactError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProjectArtifacts } from "../../../project/ProjectArtifacts.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { ProjectArtifactsToolkit } from "./tools.ts";

const targetProject = (projectId: ProjectId | undefined) =>
  readCaller().pipe(Effect.flatMap((caller) => resolveProjectId(caller, projectId)));

const failure = (error: ProjectArtifactError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const writeAccess = { what: "change this environment's project artifacts" };

export const layer = McpToolAccess.toLayer(ProjectArtifactsToolkit, {
  t3_project_artifacts_list: McpToolAccess.reads(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* targetProject(projectId);
      const artifacts = yield* ProjectArtifacts;
      return yield* artifacts.list(project).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_add: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const projectId = yield* targetProject(input.projectId);
        const artifacts = yield* ProjectArtifacts;
        return yield* artifacts
          .add({ ...input, projectId }, "agent")
          .pipe(Effect.mapError(failure));
      }),
    writeAccess,
  ),
  t3_project_artifacts_update: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const projectId = yield* targetProject(input.projectId);
        const artifacts = yield* ProjectArtifacts;
        yield* artifacts.update({ ...input, projectId }).pipe(Effect.mapError(failure));
      }),
    writeAccess,
  ),
  t3_project_artifacts_remove: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const projectId = yield* targetProject(input.projectId);
        const artifacts = yield* ProjectArtifacts;
        yield* artifacts.remove({ ...input, projectId }).pipe(Effect.mapError(failure));
      }),
    writeAccess,
  ),
});
