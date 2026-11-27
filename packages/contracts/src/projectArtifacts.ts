import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ArtifactText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const ArtifactId = TrimmedNonEmptyString;

export const ProjectArtifact = Schema.Struct({
  id: ArtifactId,
  path: Schema.String,
  label: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
});
export type ProjectArtifact = typeof ProjectArtifact.Type;

export const ProjectArtifactsScope = Schema.Struct({ projectId: ProjectId });
export const ProjectArtifactAddInput = Schema.Struct({
  ...ProjectArtifactsScope.fields,
  path: Schema.NonEmptyString,
  label: Schema.optionalKey(ArtifactText),
  description: Schema.optionalKey(ArtifactText),
});
export type ProjectArtifactAddInput = typeof ProjectArtifactAddInput.Type;

export const ProjectArtifactRemoveInput = Schema.Struct({
  ...ProjectArtifactsScope.fields,
  id: ArtifactId,
});
export type ProjectArtifactRemoveInput = typeof ProjectArtifactRemoveInput.Type;

export const ProjectArtifactUpdateInput = Schema.Struct({
  ...ProjectArtifactRemoveInput.fields,
  label: Schema.optionalKey(Schema.NullOr(ArtifactText)),
  description: Schema.optionalKey(Schema.NullOr(ArtifactText)),
});
export type ProjectArtifactUpdateInput = typeof ProjectArtifactUpdateInput.Type;

export class ProjectArtifactError extends Schema.TaggedError<ProjectArtifactError>()(
  "ProjectArtifactError",
  {
    reason: Schema.Literals(["storage", "missing-project", "missing-artifact", "invalid-file"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "storage":
        return "Could not access project artifacts.";
      case "missing-project":
        return "The project was not found.";
      case "missing-artifact":
        return "The artifact was not found.";
      case "invalid-file":
        return "The artifact must be an accessible regular file.";
    }
  }
}
