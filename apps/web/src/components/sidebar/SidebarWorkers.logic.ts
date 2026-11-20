import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "../../types";
import { groupRunningSubagentsByParent } from "../Sidebar.logic";

export function indexSidebarWorkers(threads: readonly SidebarThreadSummary[]) {
  const keyOf = (thread: SidebarThreadSummary) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const running = new Set<string>();
  for (const children of groupRunningSubagentsByParent(threads).values()) {
    for (const child of children) running.add(keyOf(child));
  }
  const present = new Set(threads.filter((thread) => thread.archivedAt === null).map(keyOf));
  const children = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const { parentThreadId, rootThreadId, relationshipToParent } = thread.lineage;
    if (
      thread.archivedAt !== null ||
      relationshipToParent !== "subagent" ||
      parentThreadId === null
    )
      continue;
    const directParent = scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId));
    const parent = present.has(directParent)
      ? directParent
      : scopedThreadKey(scopeThreadRef(thread.environmentId, rootThreadId));
    const siblings = children.get(parent);
    if (siblings) siblings.push(thread);
    else children.set(parent, [thread]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1));
  }
  return { children, running };
}

export function sidebarWorkerPage(
  idle: readonly SidebarThreadSummary[],
  limit: number,
  routePath: ReadonlySet<string>,
) {
  const visible = idle.slice(0, limit);
  const selected = idle.findIndex((child) => routePath.has(child.id));
  if (selected >= limit) visible[visible.length - 1] = idle[selected]!;
  return visible;
}
