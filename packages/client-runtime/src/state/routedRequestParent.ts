import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

/** Update the routed parent in the same state write as its child, including archive/deletion. */
export function applyRoutedRequestParent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Extract<OrchestrationV2ShellStreamItem, { kind: "thread.updated" }>,
  upsert: (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    parent: OrchestrationV2ThreadShell,
  ) => ReadonlyArray<OrchestrationV2ThreadShell>,
) {
  const parentId = event.thread.pendingRuntimeRequest?.routedTo;
  const parent = event.routedRequestParent;
  if (parentId === undefined || parent === undefined || (parent !== null && parent.id !== parentId))
    return snapshot;
  return {
    ...snapshot,
    threads:
      parent !== null && parent.archivedAt === null && parent.deletedAt === null
        ? upsert(snapshot.threads, parent)
        : snapshot.threads.filter((thread) => thread.id !== parentId),
    archivedThreads: snapshot.archivedThreads.filter((thread) => thread.id !== parentId),
  };
}
