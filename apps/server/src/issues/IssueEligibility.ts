import {
  resolveThreadRole,
  THREAD_ROLES,
  LEGACY_THREAD_ROLES,
  type IssueWorkRead,
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";

export const isReadOnlyIssueRole = (role: string | undefined) => {
  const resolved = role === undefined ? undefined : resolveThreadRole(role);
  return resolved === "checker" || resolved === "reviewer" || resolved === "investigator";
};

export const readOnlyIssueRoles = [...THREAD_ROLES, ...Object.keys(LEGACY_THREAD_ROLES)].filter(
  isReadOnlyIssueRole,
);

export const requiresManagedIssueAdmission = (
  role: string | undefined,
  parent: Pick<OrchestrationV2AppThread, "repositoryOrchestration" | "linkedIssue">,
  root: Pick<OrchestrationV2AppThread, "repositoryOrchestration">,
) =>
  !isReadOnlyIssueRole(role) &&
  (parent.repositoryOrchestration !== undefined ||
    parent.linkedIssue !== undefined ||
    root.repositoryOrchestration !== undefined);

/** Codex and Claude drivers; IssueEligibility.test.ts ties these names to the real drivers. */
export const supportsManagedIssueWork = (driver: ProviderDriverKind) =>
  driver === "codex" || driver === "claudeAgent";

export const managedIssueProviderError =
  "Managed issue work requires Codex or Claude; other adapters allow untracked native children.";

export const sameIssueRepository = (
  left: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
  right: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
) =>
  left.host.toLowerCase() === right.host.toLowerCase() && left.repositoryId === right.repositoryId;

export const issueScopeExpansionError =
  "The ancestor owner needs approval to expand the milestone or repository scope.";

export const openBlockerSuspensionReason =
  "An issue host blocker is open. Resolve it before resuming.";

// Older persisted suspensions still need automatic recovery after the wording changes.
export const openBlockerSuspensionReasons = [
  openBlockerSuspensionReason,
  "A GitHub blocker is open. Resolve it before resuming.",
];
export const isOpenBlockerSuspension = (reason: string | undefined) =>
  reason !== undefined && openBlockerSuspensionReasons.includes(reason);

export const unreadableRelationshipsSuspensionReason =
  "Issue relationships are unreadable. Restore access before resuming.";

export const isAutomaticIssueSuspension = (reason: string | undefined) =>
  isOpenBlockerSuspension(reason) || reason === unreadableRelationshipsSuspensionReason;

/** Failed or partial relationship reads never authorize a worker. */
export function issueEligibility(
  read: IssueWorkRead,
): "eligible" | "closed" | "blocked" | "unknown" {
  if (!read.parentComplete || !read.subIssuesComplete || !read.blockersComplete) return "unknown";
  if (read.state !== "open") return "closed";
  return read.blockedBy.some((blocker) => blocker.state === "open") ? "blocked" : "eligible";
}
