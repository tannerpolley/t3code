import type {
  EnvironmentId,
  ProjectId,
  SidebarLayout,
  SidebarProjectSection,
  ThreadId,
} from "@t3tools/contracts";
import { activeThreadSortKey, planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type PlacedThread = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly createdAt: string;
};

export type Layouts = ReadonlyMap<EnvironmentId, SidebarLayout>;

function rank(thread: PlacedThread, layouts: Layouts) {
  return (
    layouts.get(thread.environmentId)?.threadRanks?.[thread.id] ??
    activeThreadSortKey({ createdAt: thread.createdAt })
  );
}

export function sortProjectThreads<T extends PlacedThread>(
  threads: readonly T[],
  layouts: Layouts,
): T[] {
  return threads
    .map((thread) => ({ thread, rank: rank(thread, layouts) }))
    .sort(
      (a, b) =>
        compare(a.rank, b.rank) ||
        compare(a.thread.id, b.thread.id) ||
        compare(a.thread.environmentId, b.thread.environmentId),
    )
    .map(({ thread }) => thread);
}

export function projectThreadPlacement<T extends PlacedThread>(
  threads: readonly T[],
  moved: T,
  over: T,
  layouts: Layouts,
) {
  if (moved === over || moved.environmentId !== over.environmentId) return null;
  const from = threads.indexOf(moved);
  const to = threads.indexOf(over);
  if (from < 0 || to < 0) return null;
  const ordered = [...threads];
  ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const key = (thread: T) => `${thread.environmentId}:${thread.id}`;
  const assignments = planPinnedReorder({
    orderedIds: ordered.map(key),
    keysById: new Map(threads.map((thread) => [key(thread), rank(thread, layouts)])),
    movedId: key(moved),
  });
  const ids = new Map(
    threads
      .filter((thread) => thread.environmentId === moved.environmentId)
      .map((thread) => [key(thread), thread.id]),
  );
  if (assignments.some(({ id }) => !ids.has(id))) return null;
  return Object.fromEntries(assignments.map(({ id, orderKey }) => [ids.get(id)!, orderKey]));
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
    .toSorted((a, b) => order(a) - order(b) || compare(a.group.projectKey, b.group.projectKey))) {
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
