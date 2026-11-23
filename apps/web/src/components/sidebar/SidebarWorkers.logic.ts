import { workerListParentIds } from "@t3tools/contracts";
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
  const lineages = new Map(threads.map((thread) => [keyOf(thread), thread.lineage]));
  const children = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const { environmentId, lineage } = thread;
    if (thread.archivedAt !== null || lineage.relationshipToParent !== "subagent") continue;
    for (const id of workerListParentIds(lineage, (id) =>
      lineages.get(scopedThreadKey(scopeThreadRef(environmentId, id))),
    )) {
      const parent = scopedThreadKey(scopeThreadRef(environmentId, id));
      const siblings = children.get(parent);
      if (siblings) siblings.push(thread);
      else children.set(parent, [thread]);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1));
  }
  return { children, running };
}

export function sidebarWorkerPage(
  idle: readonly SidebarThreadSummary[],
  limit: number,
  selectedId: string | null,
) {
  const visible = idle.slice(0, limit);
  const selected = idle.findIndex((child) => child.id === selectedId);
  if (selected >= limit) visible[visible.length - 1] = idle[selected]!;
  return visible;
}
