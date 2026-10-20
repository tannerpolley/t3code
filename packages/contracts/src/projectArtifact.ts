import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectArtifactScope = Schema.Struct({ projectId: ProjectId });
export const ProjectArtifactAddInput = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type ProjectArtifactAddInput = typeof ProjectArtifactAddInput.Type;
export const ProjectArtifactRemoveInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.String,
});
export type ProjectArtifactRemoveInput = typeof ProjectArtifactRemoveInput.Type;
export const ProjectArtifact = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  resolvedPath: Schema.String,
  name: Schema.String,
  label: Schema.NullOr(Schema.String),
  addedBy: Schema.Literals(["user", "agent"]),
  available: Schema.Boolean,
});
export type ProjectArtifact = typeof ProjectArtifact.Type;
export const ProjectArtifactList = Schema.Array(ProjectArtifact);
export class ProjectArtifactError extends Schema.TaggedError<ProjectArtifactError>()(
  "ProjectArtifactError",
  {
    reason: Schema.Literals(["project-not-found", "invalid-path", "not-a-file", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "project-not-found":
        return "The project was not found.";
      case "invalid-path":
        return "Choose a file inside the project or enter an absolute file path.";
      case "not-a-file":
        return "The path does not point to an existing file.";
      case "storage":
        return "The project's artifacts could not be saved or loaded.";
    }
  }
}
