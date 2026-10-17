import type { IssueWorkRead, ProviderDriverKind, ThreadLinkedIssue } from "@t3tools/contracts";

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

export const openBlockerSuspensionReason = "A GitHub blocker is open. Resolve it before resuming.";

/** Failed or partial relationship reads never authorize a worker. */
export function issueEligibility(
  read: IssueWorkRead,
): "eligible" | "closed" | "blocked" | "unknown" {
  if (!read.parentComplete || !read.subIssuesComplete || !read.blockersComplete) return "unknown";
  if (read.state !== "open") return "closed";
  return read.blockedBy.some((blocker) => blocker.state === "open") ? "blocked" : "eligible";
}
