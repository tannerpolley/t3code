import * as Schema from "effect/Schema";
import { ProjectIconColor } from "./project.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
export const SidebarProjectSection = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  /** Stable environment-local project IDs, never repository grouping keys. */
  projectKeys: Schema.Array(TrimmedNonEmptyString),
  collapsed: Schema.Boolean,
  color: Schema.optionalKey(ProjectIconColor),
  parentId: Schema.optionalKey(TrimmedNonEmptyString),
  folderIcons: Schema.optionalKey(Schema.Boolean),
});
export type SidebarProjectSection = typeof SidebarProjectSection.Type;
export const SidebarLayout = Schema.Struct({
  sidebarProjectSections: Schema.Array(SidebarProjectSection),
  projectExpandedById: Schema.Record(Schema.String, Schema.Boolean),
  projectOrder: Schema.Array(Schema.String),
  sidebarOtherProjectsExpanded: Schema.Boolean,
}).check(
  Schema.makeFilter((layout) => {
    const ids = new Set(layout.sidebarProjectSections.map((section) => section.id));
    const top = new Set(
      layout.sidebarProjectSections
        .filter((section) => section.parentId === undefined)
        .map((section) => section.id),
    );
    const keys = layout.sidebarProjectSections.flatMap((section) => section.projectKeys);
    return (
      ids.size === layout.sidebarProjectSections.length &&
      new Set(keys).size === keys.length &&
      layout.sidebarProjectSections.every(
        (section) => section.parentId === undefined || top.has(section.parentId),
      )
    );
  }),
);
export type SidebarLayout = typeof SidebarLayout.Type;
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = {
  sidebarProjectSections: [],
  projectExpandedById: {},
  projectOrder: [],
  sidebarOtherProjectsExpanded: true,
};
const id = TrimmedNonEmptyString;
export const SidebarLayoutMutation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("migrate"), layout: SidebarLayout }),
  Schema.Struct({
    type: Schema.Literal("add"),
    section: Schema.Struct({
      id,
      name: SidebarProjectSection.fields.name,
      parentId: Schema.optionalKey(id),
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
