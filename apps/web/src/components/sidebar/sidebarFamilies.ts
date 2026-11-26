import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export function indexSidebarChildren(
  threads: readonly EnvironmentThreadShell[],
  delegatedUnderParent: ReadonlySet<string>,
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
            delegatedUnderParent.has(
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            )
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
  hasLiveChildren: boolean;
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
        hasLiveChildren,
        expanded: hasLiveChildren || (expansion.get(key) ?? hasChildRoute),
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
