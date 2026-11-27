import type { EnvironmentId, ProjectId, SidebarProjectSection, ThreadId } from "@t3tools/contracts";
import {
  projectThreadRank,
  type PlacedThread,
  type ProjectThreadLayouts,
  pinOrderKeyBetween,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export { sortProjectThreads } from "@t3tools/client-runtime/state/thread-sort";
export type Layouts = ProjectThreadLayouts;

export function projectThreadPlacement<T extends PlacedThread>(
  threads: readonly T[],
  moved: T,
  over: T,
  layouts: Layouts,
) {
  if (moved === over) return null;
  const from = threads.indexOf(moved);
  const to = threads.indexOf(over);
  if (from < 0 || to < 0) return null;
  const ordered = [...threads];
  ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const key = (thread: T) => `${thread.environmentId}:${thread.id}`;
  const assignments = planPinnedReorder({
    orderedIds: ordered.map(key),
    keysById: new Map(threads.map((thread) => [key(thread), projectThreadRank(thread, layouts)])),
    movedId: key(moved),
  });
  const ids = new Map(
    threads
      .filter((thread) => thread.environmentId === moved.environmentId)
      .map((thread) => [key(thread), thread.id]),
  );
  if (assignments.every(({ id }) => ids.has(id))) {
    return Object.fromEntries(assignments.map(({ id, orderKey }) => [ids.get(id)!, orderKey]));
  }

  // Equal ranks can force a rebalance. Foreign rows stay fixed and bound the local run.
  let start = to;
  let end = to + 1;
  while (ordered[start - 1]?.environmentId === moved.environmentId) start -= 1;
  while (ordered[end]?.environmentId === moved.environmentId) end += 1;
  const left = ordered[start - 1];
  const right = ordered[end];
  let before = left ? projectThreadRank(left, layouts) : null;
  const after = right ? projectThreadRank(right, layouts) : null;
  const localAssignments: Array<[ThreadId, string]> = [];
  for (const thread of ordered.slice(start, end)) {
    const next = pinOrderKeyBetween(before, after);
    if (next === null) return null;
    localAssignments.push([thread.id, next]);
    before = next;
  }
  return Object.fromEntries(localAssignments);
}

export type ProjectSectionRow<F> =
  | {
      readonly kind: "section";
      readonly environmentId: EnvironmentId;
      readonly section: SidebarProjectSection;
      readonly id: string;
      readonly parent?: string;
      readonly depth: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "folder";
      readonly folder: F;
      readonly parent?: string;
      readonly depth: number;
    };

export function projectSectionRows<
  F extends { readonly group: Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs"> },
>(
  folders: readonly F[],
  layouts: Layouts,
  collapsedById: ReadonlyMap<string, boolean>,
  scoped = false,
): ProjectSectionRow<F>[] {
  const rows: ProjectSectionRow<F>[] = [];
  const claimed = new Set<F>();
  const foldersByProject = new Map<string, F>();
  for (const folder of folders) {
    for (const member of folder.group.memberProjectRefs) {
      foldersByProject.set(`${member.environmentId}:${member.projectId}`, folder);
    }
  }
  for (const [environmentId, layout] of layouts) {
    const sections = new Map(layout.sidebarProjectSections.map((section) => [section.id, section]));
    const childrenByParent = new Map<string, SidebarProjectSection[]>();
    const matchingSections = new Set<string>();
    for (const section of sections.values()) {
      if (section.parentId !== undefined) {
        const children = childrenByParent.get(section.parentId) ?? [];
        children.push(section);
        childrenByParent.set(section.parentId, children);
      }
      if (
        scoped &&
        section.projectKeys.some((key) => foldersByProject.has(`${environmentId}:${key}`))
      ) {
        for (
          let ancestor: SidebarProjectSection | undefined = section;
          ancestor && !matchingSections.has(ancestor.id);
        ) {
          matchingSections.add(ancestor.id);
          ancestor = ancestor.parentId ? sections.get(ancestor.parentId) : undefined;
        }
      }
    }
    const visited = new Set<string>();
    const walk = (
      section: SidebarProjectSection,
      parent: string | undefined,
      depth: number,
      hidden: boolean,
    ) => {
      if (visited.has(section.id) || (scoped && !matchingSections.has(section.id))) return;
      visited.add(section.id);
      const id = `project-section:${environmentId}:${section.id}`;
      const collapsed = collapsedById.get(id) ?? section.collapsed;
      if (!hidden)
        rows.push({
          kind: "section",
          environmentId,
          section,
          id,
          ...(parent === undefined ? {} : { parent }),
          depth,
          collapsed,
        });
      const children = childrenByParent.get(section.id) ?? [];
      const projects = new Set(section.projectKeys);
      const childByKey = new Map(children.map((child) => [`section:${child.id}`, child]));
      const childOrder = new Set([
        ...(section.childOrder ?? []),
        ...childByKey.keys(),
        ...projects,
      ]);
      for (const key of childOrder) {
        const child = childByKey.get(key);
        if (child) walk(child, id, depth + 1, hidden || collapsed);
        else if (projects.has(key)) {
          const folder = foldersByProject.get(`${environmentId}:${key}`);
          if (!folder || claimed.has(folder)) continue;
          claimed.add(folder);
          if (!hidden && !collapsed)
            rows.push({ kind: "folder", folder, parent: id, depth: depth + 1 });
        }
      }
    };
    for (const section of sections.values()) {
      if (!section.parentId || !sections.has(section.parentId)) walk(section, undefined, 0, false);
    }
    for (const section of sections.values()) walk(section, undefined, 0, false);
  }

  const projectOrder = new Map<string, number>();
  for (const [environmentId, layout] of layouts) {
    for (const key of layout.projectOrder)
      projectOrder.set(`${environmentId}:${key}`, projectOrder.size);
  }
  const order = (folder: F) =>
    Math.min(
      ...folder.group.memberProjectRefs.map(
        ({ environmentId, projectId }) =>
          projectOrder.get(`${environmentId}:${projectId}`) ?? Infinity,
      ),
    );
  for (const folder of folders
    .filter((folder) => !claimed.has(folder))
    .toSorted((a, b) => order(a) - order(b))) {
    rows.push({ kind: "folder", folder, depth: 0 });
  }
  return rows;
}

export function sectionProjectIds(
  group: SidebarProjectSnapshot,
  environmentId: EnvironmentId,
): ProjectId[] {
  return group.memberProjectRefs
    .filter((ref) => ref.environmentId === environmentId)
    .map((ref) => ref.projectId);
}
