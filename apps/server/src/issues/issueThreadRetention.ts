import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

// Only storage cleanup can confirm that the worktree's current head was merged.
export function keepIssueWorktree(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "linkedIssue" | "worktreePath" | "archivedAt" | "deletedAt"
  >,
  merged = false,
): boolean {
  return (
    thread.linkedIssue != null &&
    thread.worktreePath != null &&
    thread.archivedAt == null &&
    thread.deletedAt == null &&
    !merged
  );
}
