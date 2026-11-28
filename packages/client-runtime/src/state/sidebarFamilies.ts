import {
  isDelegationModelRole,
  type EnvironmentId,
  type ScopedProjectRef,
  type SidebarProjectSection,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { SidebarThreadStatus } from "../sidebarRowModel.ts";
import { scopeThreadRef, scopedThreadKey } from "../environment/index.ts";
import { threadRuntimeIsActive } from "./models.ts";
import type { ProjectThreadLayouts } from "./threadSort.ts";
import type { EnvironmentThreadShell } from "./shell.ts";

export function indexSidebarChildren(
  threads: readonly EnvironmentThreadShell[],
  delegatedUnderParent?: ReadonlySet<string>,
) {
  const children = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.lineage.sideChat || thread.lineage.workflowStep)
      continue;
    const localParent = thread.lineage.parentThreadId;
    const parent =
      thread.lineage.relationshipToParent === "subagent" && localParent !== null
        ? scopeThreadRef(thread.environmentId, localParent)
        : thread.delegatedFrom != null &&
            (delegatedUnderParent?.has(
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            ) ??
              true)
          ? scopeThreadRef(thread.delegatedFrom.environmentId, thread.delegatedFrom.threadId)
          : null;
    if (parent === null) continue;
    const parentKey = scopedThreadKey(parent);
    const siblings = children.get(parentKey);
    if (siblings === undefined) children.set(parentKey, [thread]);
    else siblings.push(thread);
  }
  return children;
}

export interface SidebarFamilyRow {
  kind: "thread";
  thread: EnvironmentThreadShell;
  key: string;
  parentKey: string | undefined;
  depth: number;
  descendantCount: number;
  expanded: boolean;
}

export function sidebarFamilyRows(
  roots: readonly EnvironmentThreadShell[],
  childrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>,
  expansion: ReadonlyMap<string, boolean>,
  routeKey: string | null,
  roleExpanded: (key: string) => boolean,
) {
  type FamilyNode = {
    row: SidebarFamilyRow;
    children: FamilyNode[];
    live: boolean;
    hasRoute: boolean;
  };

  function build(thread: EnvironmentThreadShell, parentKey?: string): FamilyNode {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const children: FamilyNode[] = (childrenByParent.get(key) ?? []).map((child) =>
      build(child, key),
    );
    const hasLiveChildren = children.some((child) => child.live);
    const hasChildRoute = children.some((child) => child.hasRoute);
    const row: SidebarFamilyRow = {
      kind: "thread",
      thread,
      key,
      parentKey,
      depth: 0,
      descendantCount: children.reduce((count, child) => count + 1 + child.row.descendantCount, 0),
      expanded: expansion.get(key) ?? (hasLiveChildren || hasChildRoute),
    };
    return {
      row,
      children,
      live:
        hasLiveChildren ||
        threadRuntimeIsActive(thread.runtime) ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest != null ||
        (thread.pendingGuestMessageCount ?? 0) > 0,
      hasRoute: hasChildRoute || key === routeKey,
    };
  }

  function flatten(
    node: FamilyNode,
    depth = 0,
    parentKey = node.row.parentKey,
  ): SidebarFamilyItem[] {
    const { row, children } = node;
    const result: SidebarFamilyItem[] = [{ ...row, depth, parentKey }];
    if (!row.expanded) return result;
    if (row.thread.lineage.parentThreadId !== null || row.thread.delegatedFrom != null) {
      return result.concat(children.flatMap((child) => flatten(child, depth + 1)));
    }
    for (const section of sidebarRoleSections(row.key, children)) {
      const expanded = roleExpanded(section.key);
      result.push({
        kind: "role",
        key: section.key,
        parentKey: row.key,
        depth: depth + 1,
        role: section.role,
        threads: section.children.map((child) => child.row.thread),
        expanded,
      });
      for (const child of section.children) {
        if (expanded || child.hasRoute) {
          result.push(...flatten(child, depth + 2, section.key));
        }
      }
    }
    return result;
  }

  return new Map(
    roots.map((thread) => {
      const node = build(thread);
      return [node.row.key, flatten(node)] as const;
    }),
  );
}

const SIDEBAR_AGENT_ROLES = [
  "implementation",
  "review",
  "design",
  "writer",
  "research",
  "test",
  "other",
] as const;
export type SidebarAgentRole = (typeof SIDEBAR_AGENT_ROLES)[number];

function sidebarAgentRole(thread: Pick<EnvironmentThreadShell, "delegatedRole">) {
  const role = thread.delegatedRole;
  return isDelegationModelRole(role) ? role : "other";
}

export type SidebarFamilyItem =
  | SidebarFamilyRow
  | {
      kind: "role";
      key: string;
      parentKey: string;
      depth: number;
      role: SidebarAgentRole;
      threads: readonly EnvironmentThreadShell[];
      expanded: boolean;
    };

function sidebarRoleSections<T extends { row: SidebarFamilyRow }>(
  parentKey: string,
  children: readonly T[],
) {
  const byRole = new Map<SidebarAgentRole, T[]>();
  for (const child of children) {
    const role = sidebarAgentRole(child.row.thread);
    const siblings = byRole.get(role);
    if (siblings === undefined) byRole.set(role, [child]);
    else siblings.push(child);
  }
  return SIDEBAR_AGENT_ROLES.flatMap((role) => {
    const children = byRole.get(role);
    return children === undefined
      ? []
      : [
          {
            key: `role:${parentKey}:${role}`,
            role,
            children: children.sort((a, b) =>
              b.row.thread.createdAt.localeCompare(a.row.thread.createdAt),
            ),
          },
        ];
  });
}

export type SidebarAgentState = "working" | "attention" | "failed";

/** How many threads are in each state; the caller decides each thread's state. */
export function countSidebarAgentStates<T>(
  threads: readonly T[],
  stateOf: (thread: T) => SidebarAgentState | null,
) {
  const counts: Record<SidebarAgentState, number> = { working: 0, attention: 0, failed: 0 };
  for (const thread of threads) {
    const state = stateOf(thread);
    if (state !== null) counts[state] += 1;
  }
  return counts;
}

export const sidebarRoleSectionLabels: Record<SidebarAgentRole, string> = {
  implementation: msg("Implementors"),
  review: msg("Reviewers"),
  design: msg("Designers"),
  writer: msg("Writers"),
  research: msg("Researchers"),
  test: msg("Testers"),
  other: msg("Other agents"),
};

export function sidebarAgentState(
  status: SidebarThreadStatus,
  running: boolean,
): SidebarAgentState | null {
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "attention";
    case "failed":
      return "failed";
    case "preparing":
    case "working":
      return "working";
    case "waiting":
      // Blocked on a child is still a running turn; an idle session is not.
      return running ? "working" : null;
    default:
      return null;
  }
}

/** "2 working · 1 waiting on you · 1 failed", leaving out zeros; `short` says "waiting". */
export function formatSidebarAgentStates(
  counts: Readonly<Record<SidebarAgentState, number>>,
  resolve: MFunctionType = mFallback,
  short = false,
): string {
  const parts = [
    counts.working > 0 ? resolve(msg("{count} working", { count: counts.working })) : null,
    counts.attention > 0
      ? short
        ? resolve(msg("{count} waiting", { count: counts.attention }))
        : resolve(msg("{count} waiting on you", { count: counts.attention }))
      : null,
    counts.failed > 0 ? resolve(msg("{count} failed", { count: counts.failed })) : null,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

/**
 * Boring sidebar folders. Folders follow `groups` order and threads keep their
 * input order. A project with no threads gets a folder only when `keepEmpty` says so.
 * A thread whose project is in no group has no folder and is left out.
 */
export function groupSidebarThreadsByProject<
  TGroup extends {
    readonly projectKey: string;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  },
  TThread extends { readonly environmentId: string; readonly projectId: string },
>(groups: readonly TGroup[], threads: readonly TThread[], keepEmpty: (group: TGroup) => boolean) {
  const folders = groups.map((group) => ({ group, threads: [] as TThread[] }));
  const folderByProject = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    for (const ref of folder.group.memberProjectRefs) {
      folderByProject.set(`${ref.environmentId}:${ref.projectId}`, folder);
    }
  }
  for (const thread of threads) {
    folderByProject.get(`${thread.environmentId}:${thread.projectId}`)?.threads.push(thread);
  }
  return folders.filter((folder) => folder.threads.length > 0 || keepEmpty(folder.group));
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
  F extends { readonly group: { readonly memberProjectRefs: readonly ScopedProjectRef[] } },
>(
  folders: readonly F[],
  layouts: ProjectThreadLayouts,
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
    .sort((a, b) => order(a) - order(b))) {
    rows.push({ kind: "folder", folder, depth: 0 });
  }
  return rows;
}
