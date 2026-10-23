import type { OrchestrationV2AppThread } from "./orchestrationV2.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";
import type { RepositoryOrchestration } from "./issueWork.ts";
import { effectiveThreadRole } from "./threadRole.ts";

type Candidate = Pick<
  OrchestrationV2AppThread,
  | "id"
  | "projectId"
  | "role"
  | "branch"
  | "worktreePath"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "linkedIssue"
  | "repositoryOrchestration"
>;

/** Ownership decisions must apply this to the current projection while holding the target lock. */
export function isRepositoryOrchestratorEligible(
  thread: Candidate | null,
  driver: ProviderDriverKind | undefined,
  repository: Pick<RepositoryOrchestration, "projectId" | "host" | "repository"> & {
    readonly repositoryId?: string;
  },
): boolean {
  if (thread === null) return false;
  const registered = thread.repositoryOrchestration;
  return (
    thread.projectId === repository.projectId &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.lineage.rootThreadId === thread.id &&
    thread.linkedIssue === undefined &&
    thread.worktreePath === null &&
    effectiveThreadRole(thread) === "orchestrator" &&
    (driver === "codex" || driver === "claudeAgent") &&
    (registered === undefined ||
      (registered.projectId === repository.projectId &&
        registered.host.toLowerCase() === repository.host.toLowerCase() &&
        registered.repository.toLowerCase() === repository.repository.toLowerCase() &&
        (repository.repositoryId === undefined ||
          registered.repositoryId === repository.repositoryId)))
  );
}
