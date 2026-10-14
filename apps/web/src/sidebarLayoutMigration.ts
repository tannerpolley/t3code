import { SidebarLayout, EnvironmentId, type SidebarLayoutMutation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const PendingImport = Schema.Struct({
  importId: Schema.String,
  legacy: SidebarLayout,
  memberships: Schema.Array(Schema.String),
});
export type PendingSidebarImport = typeof PendingImport.Type;
const decodePending = Schema.decodeUnknownOption(Schema.fromJsonString(PendingImport));
const key = (environmentId: EnvironmentId) => "t3code:sidebar-import-pending:" + environmentId;
export function readPendingSidebarImport(environmentId: EnvironmentId) {
  try {
    const saved = localStorage.getItem(key(environmentId));
    return saved ? Option.getOrNull(decodePending(saved)) : null;
  } catch {
    return null;
  }
}
export function savePendingSidebarImport(
  environmentId: EnvironmentId,
  pending: PendingSidebarImport | null,
) {
  try {
    if (pending === null) localStorage.removeItem(key(environmentId));
    else localStorage.setItem(key(environmentId), JSON.stringify(pending));
  } catch {
    /* The in-memory candidate remains usable if storage is unavailable. */
  }
}
export function sidebarImportMemberships(candidate: SidebarLayout) {
  return candidate.sidebarProjectSections.flatMap((section) =>
    section.projectKeys.map((id) => JSON.stringify([section.id, id])),
  );
}
/** Resume unresolved aliases without replacing the owner's subsequent edits. */
export function resolvePendingSidebarImport(
  candidate: SidebarLayout,
  current: SidebarLayout,
  imported: Set<string>,
) {
  const operations: SidebarLayoutMutation[] = [];
  const sections = new Set(current.sidebarProjectSections.map((section) => section.id));
  for (const section of candidate.sidebarProjectSections) {
    const newlyResolved = section.projectKeys.filter(
      (id) => !imported.has(JSON.stringify([section.id, id])),
    );
    if (!newlyResolved.length) continue;
    if (!sections.has(section.id)) {
      const parent = candidate.sidebarProjectSections.find(
        (saved) => saved.id === section.parentId,
      );
      if (parent && !sections.has(parent.id)) {
        operations.push({ type: "add", section: { id: parent.id, name: parent.name } });
        sections.add(parent.id);
      }
      operations.push({
        type: "add",
        section: {
          id: section.id,
          name: section.name,
          ...(section.parentId ? { parentId: section.parentId } : {}),
        },
      });
      sections.add(section.id);
    }
    for (const id of newlyResolved) {
      imported.add(JSON.stringify([section.id, id]));
      if (!current.sidebarProjectSections.some((saved) => saved.projectKeys.includes(id)))
        operations.push({ type: "move", sectionId: section.id, projectKeys: [id] });
      const expanded = candidate.projectExpandedById[id];
      if (expanded !== undefined && current.projectExpandedById[id] === undefined)
        operations.push({ type: "projectExpanded", projectKeys: [id], expanded });
    }
  }
  return operations;
}
