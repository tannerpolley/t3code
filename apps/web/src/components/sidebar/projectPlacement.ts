import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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

export function sectionProjectIds(
  group: SidebarProjectSnapshot,
  environmentId: EnvironmentId,
): ProjectId[] {
  return group.memberProjectRefs
    .filter((ref) => ref.environmentId === environmentId)
    .map((ref) => ref.projectId);
}
