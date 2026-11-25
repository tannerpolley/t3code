import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectIconColor } from "./project.ts";
import {
  ForwardCompatibleArray,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
export const SidebarProjectSection = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  /** Stable environment-local project IDs, never repository grouping keys. */
  projectKeys: ForwardCompatibleArray(TrimmedNonEmptyString),
  collapsed: Schema.Boolean,
  color: Schema.optionalKey(ProjectIconColor),
  parentId: Schema.optionalKey(TrimmedNonEmptyString),
  folderIcons: Schema.optionalKey(Schema.Boolean),
  folderPath: Schema.optionalKey(TrimmedNonEmptyString),
  childOrder: Schema.optionalKey(ForwardCompatibleArray(TrimmedNonEmptyString)),
});
export type SidebarProjectSection = typeof SidebarProjectSection.Type;
const SidebarProjectExpansion = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.Boolean),
    SchemaTransformation.transform<Record<string, boolean>, Record<string, unknown>>({
      decode: (values) =>
        Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        ),
      encode: (values) => values,
    }),
  ),
);
const Rank = Schema.String.check(Schema.isPattern(/^0?[a-z]*[b-z]$/), Schema.isMaxLength(160));

export const SidebarLayout = Schema.Struct({
  sidebarProjectSections: ForwardCompatibleArray(SidebarProjectSection),
  projectExpandedById: SidebarProjectExpansion,
  projectOrder: ForwardCompatibleArray(Schema.String),
  sidebarOtherProjectsExpanded: Schema.Boolean,
  threadRanks: Schema.optionalKey(Schema.Record(ThreadId, Rank)),
});
export type SidebarLayout = typeof SidebarLayout.Type;
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = {
  sidebarProjectSections: [],
  projectExpandedById: {},
  projectOrder: [],
  sidebarOtherProjectsExpanded: true,
};

const sectionId = TrimmedNonEmptyString;
const name = SidebarProjectSection.fields.name;
const projectIds = Schema.Array(ProjectId).check(Schema.isMinLength(1));

export const SidebarLayoutMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("add"),
    sectionId,
    name,
    projectIds: Schema.optionalKey(projectIds),
  }),
  Schema.Struct({ type: Schema.Literal("rename"), sectionId, name }),
  Schema.Struct({ type: Schema.Literal("delete"), sectionId }),
  Schema.Struct({ type: Schema.Literal("collapse"), sectionId, collapsed: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("move"), sectionId: Schema.NullOr(sectionId), projectIds }),
  Schema.Struct({ type: Schema.Literal("expandProjects"), projectIds, expanded: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("placeThreads"), ranks: Schema.Record(ThreadId, Rank) }),
]);
export type SidebarLayoutMutation = typeof SidebarLayoutMutation.Type;

export const SidebarLayoutRecord = Schema.Struct({
  revision: Schema.Int,
  layout: SidebarLayout,
});
export type SidebarLayoutRecord = typeof SidebarLayoutRecord.Type;

export const SidebarLayoutUpdate = Schema.Struct({
  revision: Schema.Int,
  mutation: SidebarLayoutMutation,
});
export type SidebarLayoutUpdate = typeof SidebarLayoutUpdate.Type;

export class SidebarLayoutError extends Schema.TaggedError<SidebarLayoutError>()(
  "SidebarLayoutError",
  {
    reason: Schema.Literals([
      "read",
      "write",
      "stale",
      "missing-section",
      "missing-project",
      "missing-thread",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "stale":
        return "The sidebar layout changed. Try again.";
      case "missing-section":
        return "This sidebar section no longer exists.";
      case "missing-project":
        return "A project in this sidebar change no longer exists.";
      case "missing-thread":
        return "A thread in this sidebar change no longer exists.";
      case "read":
        return "Could not read the sidebar layout.";
      case "write":
        return "Could not save the sidebar layout.";
    }
  }
}
