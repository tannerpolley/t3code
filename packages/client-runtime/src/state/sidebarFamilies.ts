import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { SidebarThreadStatus } from "../sidebarRowModel.ts";
import { scopeThreadRef, scopedThreadKey } from "../environment/index.ts";
import { threadRuntimeIsActive } from "./models.ts";
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
  thread: EnvironmentThreadShell;
  key: string;
  parentKey: string | undefined;
  depth: number;
  descendantCount: number;
  expanded: boolean;
  children: readonly SidebarFamilyRow[];
}

export function sidebarFamilyRows(
  roots: readonly EnvironmentThreadShell[],
  childrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>,
  expansion: ReadonlyMap<string, boolean>,
  routeKey: string | null,
) {
  function build(
    thread: EnvironmentThreadShell,
    depth: number,
    parentKey?: string,
  ): { row: SidebarFamilyRow; live: boolean; hasRoute: boolean } {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const children = (childrenByParent.get(key) ?? []).map((child) => build(child, depth + 1, key));
    const hasLiveChildren = children.some((child) => child.live);
    const hasChildRoute = children.some((child) => child.hasRoute);
    return {
      row: {
        thread,
        key,
        parentKey,
        depth,
        descendantCount: children.reduce(
          (count, child) => count + 1 + child.row.descendantCount,
          0,
        ),
        expanded: expansion.get(key) ?? (hasLiveChildren || hasChildRoute),
        children: children.map((child) => child.row),
      },
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

  function flatten(row: SidebarFamilyRow): SidebarFamilyRow[] {
    return row.expanded ? [row, ...row.children.flatMap(flatten)] : [row];
  }

  return new Map(
    roots.map((thread) => {
      const { row } = build(thread, 0);
      return [row.key, flatten(row)] as const;
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
  return role === undefined || role === "general" ? "other" : role;
}

export interface SidebarRoleSection {
  /** Names the project and role; collapse state is saved under it. */
  key: string;
  role: SidebarAgentRole;
  threads: readonly EnvironmentThreadShell[];
}

/**
 * Child agents by project, then by role in `SIDEBAR_AGENT_ROLES` order, newest first.
 * Roles with no children are left out, and so are children whose project has no folder.
 */
export function sidebarRoleSections(
  childrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>,
  folderKeyOf: (thread: EnvironmentThreadShell) => string | undefined,
) {
  const byFolder = new Map<string, Map<SidebarAgentRole, EnvironmentThreadShell[]>>();
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      const folderKey = folderKeyOf(child);
      if (folderKey === undefined) continue;
      const roles = byFolder.get(folderKey) ?? new Map();
      byFolder.set(folderKey, roles);
      const role = sidebarAgentRole(child);
      const threads = roles.get(role);
      if (threads === undefined) roles.set(role, [child]);
      else threads.push(child);
    }
  }
  return new Map(
    [...byFolder].map(([folderKey, roles]) => [
      folderKey,
      SIDEBAR_AGENT_ROLES.flatMap((role): SidebarRoleSection[] => {
        const threads = roles.get(role);
        return threads === undefined
          ? []
          : [
              {
                key: `${folderKey}:${role}`,
                role,
                threads: [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
              },
            ];
      }),
    ]),
  );
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
