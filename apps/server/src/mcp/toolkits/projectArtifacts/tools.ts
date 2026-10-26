import {
  OrchestratorMcpFailure,
  ProjectId,
  ProjectArtifact,
  ProjectArtifactList,
  ProjectArtifactAddInput,
  ProjectArtifactMoveInput,
  ProjectArtifactUpdateInput,
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
      "List the project's pinned artifacts, grouped by section in the project's section order, including resolved paths and whether each file still exists.",
    parameters: Schema.Struct({ projectId }),
    success: ProjectArtifactList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_add", {
    ...shared,
    description:
      "Pin an existing file for every thread in a project. Pass a project-relative or absolute file path, an optional label and description (up to 200 characters each), and an optional section name; without one the pin goes to a section named after its file type (Documents, Web pages, Images, Data, Code or Files). The pin is attributed to an agent. Adding an already pinned path preserves its metadata and attribution; use t3_project_artifacts_update to edit its label or description, and t3_project_artifacts_move to change its section.",
    parameters: Schema.Struct({ ...ProjectArtifactAddInput.fields, projectId }),
    success: ProjectArtifact,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_update", {
    ...shared,
    description:
      "Update a project's artifact pin by id. Label and description are optional, up to 200 characters each; omitted fields stay unchanged. Pass null to clear either field. Clearing the label displays the file name.",
    parameters: Schema.Struct({ ...ProjectArtifactUpdateInput.fields, projectId }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_move", {
    ...shared,
    description:
      "Move a project's artifact pin by id to another section, creating the section if it is new. An emptied section disappears.",
    parameters: Schema.Struct({ ...ProjectArtifactMoveInput.fields, projectId }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_artifacts_remove", {
    ...shared,
    description: "Remove a project's artifact pin by id. This does not delete the file.",
    parameters: Schema.Struct({ projectId, id: Schema.String }),
    success: Schema.Void,
  }).annotate(Tool.Destructive, false),
);
