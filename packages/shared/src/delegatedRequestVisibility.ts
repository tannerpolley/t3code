import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

export type RoutedRequestParent = Pick<
  OrchestrationV2ThreadShell,
  "activeRunId" | "activityRunStatus" | "status" | "archivedAt" | "deletedAt"
>;

/** Routing records who should answer first; only live work can hide it from the owner. */
export function runtimeRequestIsOwnerVisible(
  request: { readonly routedTo?: ThreadId | undefined } | null | undefined,
  parent: RoutedRequestParent | null | undefined,
): boolean {
  if (request == null) return false;
  if (request.routedTo === undefined) return true;
  if (parent == null || parent.archivedAt !== null || parent.deletedAt !== null) return true;
  // Shell status excludes held queues. A blocking tool wait still owns an active run.
  return !(
    parent.activeRunId !== null ||
    parent.activityRunStatus != null ||
    parent.status === "queued" ||
    parent.status === "preparing" ||
    parent.status === "starting" ||
    parent.status === "running" ||
    parent.status === "waiting"
  );
}
