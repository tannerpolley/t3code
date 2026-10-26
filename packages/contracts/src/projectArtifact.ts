import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SECTION_EXTENSIONS = {
  Documents: ["pdf", "md", "txt", "docx", "qmd", "tex", "rst"],
  "Web pages": ["html", "htm"],
  Images: ["png", "jpg", "jpeg", "gif", "svg", "webp"],
  Data: ["csv", "tsv", "json", "jsonl", "parquet", "xlsx", "sqlite", "yaml", "yml", "toml"],
  Code: [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "py",
    "ipynb",
    "r",
    "jl",
    "m",
    "rs",
    "go",
    "java",
    "kt",
    "scala",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "swift",
    "rb",
    "php",
    "lua",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "sql",
    "css",
    "scss",
    "vue",
    "svelte",
    "f90",
    "f",
    "zig",
    "ex",
    "hs",
    "ml",
  ],
};
const sectionByExtension = new Map(
  Object.entries(SECTION_EXTENSIONS).flatMap(([section, extensions]) =>
    extensions.map((extension) => [extension, section] as const),
  ),
);

/** The section an artifact gets when it is pinned without one. */
export const defaultArtifactSection = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return sectionByExtension.get(extension) ?? "Files";
};

const SectionName = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const ArtifactText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const ProjectArtifactScope = Schema.Struct({ projectId: ProjectId });
export const ProjectArtifactAddInput = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  label: Schema.optional(ArtifactText),
  description: Schema.optional(ArtifactText),
  section: Schema.optional(
    SectionName.annotate({ description: "Defaults to a section named after the file type." }),
  ),
});
export type ProjectArtifactAddInput = typeof ProjectArtifactAddInput.Type;
export const ProjectArtifactRemoveInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.String,
});
export type ProjectArtifactRemoveInput = typeof ProjectArtifactRemoveInput.Type;
export const ProjectArtifactUpdateInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.String,
  label: Schema.optional(Schema.NullOr(ArtifactText)),
  description: Schema.optional(Schema.NullOr(ArtifactText)),
});
export type ProjectArtifactUpdateInput = typeof ProjectArtifactUpdateInput.Type;
export const ProjectArtifactMoveInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.String,
  section: SectionName,
});
export type ProjectArtifactMoveInput = typeof ProjectArtifactMoveInput.Type;
export const ProjectArtifactRenameSectionInput = Schema.Struct({
  projectId: ProjectId,
  from: Schema.String,
  to: SectionName,
});
export type ProjectArtifactRenameSectionInput = typeof ProjectArtifactRenameSectionInput.Type;
export const ProjectArtifactReorderSectionsInput = Schema.Struct({
  projectId: ProjectId,
  sections: Schema.Array(Schema.String),
});
export type ProjectArtifactReorderSectionsInput = typeof ProjectArtifactReorderSectionsInput.Type;
export const ProjectArtifact = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  resolvedPath: Schema.String,
  name: Schema.String,
  label: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * Lists return artifacts grouped by section, in the project's section order. Servers from
   * before sections omit it; their pins read as one "Files" section instead of failing to decode.
   */
  section: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("Files"))),
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
