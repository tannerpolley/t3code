import {
  OrchestratorMcpFailure,
  ProjectId,
  ProjectArtifact,
  ProjectArtifactList,
  ProjectArtifactAddInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectArtifacts from "../../../project/ProjectArtifacts.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ProjectArtifacts.ProjectArtifacts,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
const projectId = Schema.optional(
  ProjectId.annotate({ description: "Defaults to the calling thread's project." }),
);
export const ProjectArtifactsToolkit = Toolkit.make(
  Tool.make("t3_project_artifacts_list", {
    ...shared,
    description:
      "List the project's pinned artifacts, including resolved paths and whether each file still exists.",
    parameters: Schema.Struct({ projectId }),
    success: ProjectArtifactList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_add", {
    ...shared,
    description:
      "Pin an existing file for every thread in a project. Pass a project-relative or absolute file path and an optional label. The pin is attributed to an agent. Adding an already pinned path preserves its label and attribution.",
    parameters: Schema.Struct({ ...ProjectArtifactAddInput.fields, projectId }),
    success: ProjectArtifact,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_remove", {
    ...shared,
    description: "Remove a project's artifact pin by id. This does not delete the file.",
    parameters: Schema.Struct({ projectId, id: Schema.String }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
);
