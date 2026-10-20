import { OrchestratorMcpFailure, type ProjectArtifactError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectArtifacts from "../../../project/ProjectArtifacts.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { ProjectArtifactsToolkit } from "./tools.ts";

const failure = (error: ProjectArtifactError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(ProjectArtifactsToolkit, {
  t3_project_artifacts_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* ProjectArtifacts.ProjectArtifacts;
      return yield* artifacts.list(projectId).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_add: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* ProjectArtifacts.ProjectArtifacts;
      return yield* artifacts.add({ ...input, projectId }, "agent").pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_remove: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* ProjectArtifacts.ProjectArtifacts;
      return yield* artifacts.remove({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
});
