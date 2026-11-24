import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadFamily,
  type ThreadId,
  workerListParentIds,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isIssueWorkerChild } from "@t3tools/shared/issueWorkerStatus";

import type { SidebarThreadSummary } from "../../types";
import { groupRunningSubagentsByParent } from "../Sidebar.logic";

export function indexSidebarWorkers(threads: readonly SidebarThreadSummary[]) {
  const keyOf = (thread: SidebarThreadSummary) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const running = new Set<string>();
  for (const children of groupRunningSubagentsByParent(threads).values()) {
    for (const child of children) running.add(keyOf(child));
  }
  const isWorker = (thread: SidebarThreadSummary | undefined) =>
    thread !== undefined &&
    thread.archivedAt === null &&
    !isProviderNativeSubagentThread(thread.source) &&
    thread.lineage.relationshipToParent === "subagent";
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread]));
  const children = new Map<string, SidebarThreadSummary[]>();
  const parentOf = new Map<string, string>();
  for (const thread of threads) {
    const { environmentId, lineage } = thread;
    if (!isWorker(thread)) continue;
    const threadOf = (id: ThreadId) =>
      byKey.get(scopedThreadKey(scopeThreadRef(environmentId, id)));
    // A worker's own children nest under its row; others list under the listed rows above them.
    const nested =
      lineage.parentThreadId !== null &&
      lineage.parentThreadId !== thread.id &&
      isWorker(threadOf(lineage.parentThreadId));
    const parents = nested
      ? [lineage.parentThreadId!]
      : thread.source.workerAncestorIds === undefined
        ? workerListParentIds(lineage, (id) => threadOf(id)?.lineage)
        : [lineage.rootThreadId, ...thread.source.workerAncestorIds];
    if (nested) {
      parentOf.set(
        keyOf(thread),
        scopedThreadKey(scopeThreadRef(environmentId, lineage.parentThreadId!)),
      );
    }
    for (const id of parents) {
      const parent = scopedThreadKey(scopeThreadRef(environmentId, id));
      const siblings = children.get(parent);
      if (siblings) siblings.push(thread);
      else children.set(parent, [thread]);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1));
  }
  return { children, running, parentOf };
}

/** The row in `idle` that is `key` or holds it nested beneath, so a selected descendant can be revealed. */
export function idleWorkerHolding(
  idle: readonly SidebarThreadSummary[],
  parentOf: ReadonlyMap<string, string>,
  key: string,
): ThreadId | null {
  const idleIds = new Map(
    idle.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread.id,
    ]),
  );
  const seen = new Set<string>();
  for (let at: string | undefined = key; at !== undefined && !seen.has(at); at = parentOf.get(at)) {
    seen.add(at);
    const id = idleIds.get(at);
    if (id !== undefined) return id;
  }
  return null;
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

// SQLite's UTF-8 ordering follows code points, including for IDs with supplementary characters.
function threadIdBefore(left: ThreadId, right: ThreadId) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length;) {
    const a = left.codePointAt(index)!;
    const b = right.codePointAt(index)!;
    if (a !== b) return a < b;
    index += a > 0xffff ? 2 : 1;
  }
  return left.length < right.length;
}

export function remainingSidebarWorkers(
  idle: readonly SidebarThreadSummary[],
  running: readonly SidebarThreadSummary[],
  limit: number,
  page: OrchestrationV2ThreadFamily | undefined,
) {
  const hiddenIdle = Math.max(0, idle.length - limit);
  const cursor = page?.nextWorkerPage;
  const remaining = page?.remainingWorkers ?? 0;
  if (cursor === undefined || remaining === 0) return hiddenIdle;
  const onLaterPage = (worker: SidebarThreadSummary) =>
    worker.createdAt < cursor.createdAt ||
    (worker.createdAt === cursor.createdAt && threadIdBefore(worker.id, cursor.threadId));
  const knownLater = idle.filter(onLaterPage).length + running.filter(onLaterPage).length;
  return hiddenIdle + Math.max(0, remaining - knownLater);
}

/** Only finished, disposable rows recede; a Writer, a pinned thread, or an issue worker whose issue is not done will be used again. */
export function sidebarWorkerRecedes(
  thread: SidebarThreadSummary,
  issueWorkerStatus: string | null | undefined,
) {
  if (thread.pinnedAt != null) return false;
  // A provider-native "writer" cannot take follow-ups, so only a T3 Writer stays bright.
  if (thread.source.role === "writer" && !isProviderNativeSubagentThread(thread.source))
    return false;
  return !isIssueWorkerChild(thread.source) || issueWorkerStatus === "done";
}
