import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectArtifact,
  ProjectArtifactAddInput,
  ProjectArtifactRemoveInput,
  ProjectArtifactUpdateInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectArtifacts } from "../../../project/ProjectArtifacts.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [ThreadManagementService, ProjectArtifacts, McpInvocationContext],
};
const target = {
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: Schema.optionalKey(
    ProjectId.annotate({ description: "Defaults to the thread's project." }),
  ),
};

export const ProjectArtifactsToolkit = Toolkit.make(
  Tool.make("t3_project_artifacts_list", {
    ...shared,
    description: "List files saved as artifacts in a project.",
    parameters: Schema.Struct(target),
    success: Schema.Array(ProjectArtifact),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_add", {
    ...shared,
    description:
      "Save an existing file as a project artifact. Use an absolute or project-relative path. Saving the same file keeps its existing label and description.",
    parameters: Schema.Struct({ ...ProjectArtifactAddInput.fields, ...target }),
    success: ProjectArtifact,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_update", {
    ...shared,
    description: "Rename an artifact or edit its description by id. Pass null to clear a field.",
    parameters: Schema.Struct({ ...ProjectArtifactUpdateInput.fields, ...target }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_remove", {
    ...shared,
    description: "Remove a saved artifact by id and leave the file on disk.",
    parameters: Schema.Struct({ ...ProjectArtifactRemoveInput.fields, ...target }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
);
