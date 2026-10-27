import { OrchestratorMcpFailure, type ProjectArtifactError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectArtifacts from "../../../project/ProjectArtifacts.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { ProjectArtifactsToolkit } from "./tools.ts";

const readArtifacts = Effect.fn("mcp.readProjectArtifacts")(function* () {
  const service = yield* Effect.serviceOption(ProjectArtifacts.ProjectArtifacts);
  if (Option.isNone(service))
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Project artifacts are unavailable in this environment.",
    });
  return service.value;
});

const failure = (error: ProjectArtifactError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(ProjectArtifactsToolkit, {
  t3_project_artifacts_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* readArtifacts();
      return yield* artifacts.list(projectId).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_add: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* readArtifacts();
      return yield* artifacts.add({ ...input, projectId }, "agent").pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_move: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* readArtifacts();
      return yield* artifacts.move({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* readArtifacts();
      return yield* artifacts.update({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_artifacts_remove: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
      const artifacts = yield* readArtifacts();
      return yield* artifacts.remove({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
});
