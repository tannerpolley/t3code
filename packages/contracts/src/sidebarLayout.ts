import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectIconColor } from "./project.ts";
import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
export const SidebarLayout = Schema.Struct({
  sidebarProjectSections: ForwardCompatibleArray(SidebarProjectSection),
  projectExpandedById: SidebarProjectExpansion,
  projectOrder: ForwardCompatibleArray(Schema.String),
  sidebarOtherProjectsExpanded: Schema.Boolean,
});
export type SidebarLayout = typeof SidebarLayout.Type;
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = {
  sidebarProjectSections: [],
  projectExpandedById: {},
  projectOrder: [],
  sidebarOtherProjectsExpanded: true,
};
const id = TrimmedNonEmptyString;
export const SidebarLayoutMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("migrate"),
    layout: SidebarLayout,
    importId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("add"),
    section: Schema.Struct({
      id,
      name: SidebarProjectSection.fields.name,
      parentId: Schema.optionalKey(id),
      folderPath: SidebarProjectSection.fields.folderPath,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    sectionId: id,
    name: SidebarProjectSection.fields.name,
  }),
  Schema.Struct({
    type: Schema.Literal("color"),
    sectionId: id,
    color: Schema.NullOr(ProjectIconColor),
  }),
  Schema.Struct({
    type: Schema.Literal("folderIcons"),
    sectionId: id,
    folderIcons: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("delete"), sectionId: id }),
  Schema.Struct({
    type: Schema.Literal("sectionExpanded"),
    sectionId: id,
    expanded: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("move"),
    projectKeys: Schema.Array(id),
    sectionId: Schema.NullOr(id),
    expanded: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("sectionProjectsOrder"),
    sectionId: id,
    projectKeys: Schema.Array(id),
  }),
  Schema.Struct({
    type: Schema.Literal("sectionChildrenOrder"),
    sectionId: id,
    childOrder: Schema.Array(id),
  }),
  Schema.Struct({ type: Schema.Literal("sectionsOrder"), sectionIds: Schema.Array(id) }),
  Schema.Struct({
    type: Schema.Literal("projectExpanded"),
    projectKeys: Schema.Array(id),
    expanded: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("otherExpanded"), expanded: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("projectsOrder"),
    currentProjectOrder: Schema.Array(id),
    draggedProjectIds: Schema.Array(id),
    targetProjectIds: Schema.Array(id),
  }),
  Schema.Struct({
    type: Schema.Literal("organize"),
    projects: Schema.Array(
      Schema.Struct({ projectKey: id, workspaceRoots: Schema.Array(Schema.String) }),
    ),
    root: Schema.String,
    onlyUnsorted: Schema.Boolean,
  }),
]);
export type SidebarLayoutMutation = typeof SidebarLayoutMutation.Type;

export const SidebarLayoutRecord = Schema.Struct({
  revision: Schema.Int,
  legacyImportedAt: Schema.NullOr(Schema.String),
  legacyImportId: Schema.NullOr(Schema.String),
  layout: SidebarLayout,
});
export type SidebarLayoutRecord = typeof SidebarLayoutRecord.Type;
export const SidebarLayoutUpdate = Schema.Struct({
  revision: Schema.Int,
  operations: Schema.Array(SidebarLayoutMutation),
});
export type SidebarLayoutUpdate = typeof SidebarLayoutUpdate.Type;
export class SidebarLayoutError extends Schema.TaggedError<SidebarLayoutError>()(
  "SidebarLayoutError",
  { message: Schema.String },
) {}
