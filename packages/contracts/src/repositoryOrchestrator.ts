import type { OrchestrationV2AppThread } from "./orchestrationV2.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";
import { repositoryPhase, type RepositoryOrchestration } from "./issueWork.ts";
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
type RepositoryRecord = Pick<RepositoryOrchestration, "projectId" | "host" | "repository"> & {
  readonly repositoryId?: string;
};

/** Ownership decisions must apply this to the current projection while holding the target lock. */
export function isRepositoryOrchestratorEligible(
  thread: Candidate | null,
  driver: ProviderDriverKind | undefined,
  repository: RepositoryRecord,
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
    (registered === undefined || isRegisteredFor(registered, repository))
  );
}

function isRegisteredFor(registered: RepositoryOrchestration, repository: RepositoryRecord) {
  return (
    registered.projectId === repository.projectId &&
    registered.host.toLowerCase() === repository.host.toLowerCase() &&
    registered.repository.toLowerCase() === repository.repository.toLowerCase() &&
    (repository.repositoryId === undefined || registered.repositoryId === repository.repositoryId)
  );
}

/**
 * A root registered to its project's previous repository record (the project's remote moved
 * hosts) may register for the project's current record once the old one is paused and settled.
 * Pausing accepts that the move discards the old record's plans, suspensions and usage sprint, so
 * `allowIdle` (a user assignment, which has no screen to pause from) needs a record with none.
 */
export function isMovableRepositoryRegistration(
  registered: RepositoryOrchestration | undefined,
  repository: RepositoryRecord & { readonly repositoryId: string },
  allowIdle = false,
): registered is RepositoryOrchestration {
  return (
    registered !== undefined &&
    registered.projectId === repository.projectId &&
    !isRegisteredFor(registered, repository) &&
    (registered.paused ||
      (allowIdle &&
        registered.milestones.length === 0 &&
        registered.suspendedIssues.length === 0 &&
        registered.usageSprint === undefined)) &&
    repositoryPhase(registered) !== "retired" &&
    registered.handoff === undefined
  );
}
