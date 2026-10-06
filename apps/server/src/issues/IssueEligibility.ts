import type { IssueWorkRead, ProviderDriverKind, ThreadLinkedIssue } from "@t3tools/contracts";

export const supportsManagedIssueWork = (driver: ProviderDriverKind) =>
  driver === "codex" || driver === "claude";

export const managedIssueProviderError =
  "Managed issue work requires Codex or Claude; other adapters allow untracked native children.";

export const sameIssueRepository = (
  left: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
  right: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
) =>
  left.host.toLowerCase() === right.host.toLowerCase() && left.repositoryId === right.repositoryId;

export const issueScopeExpansionError =
  "The ancestor owner needs approval to expand the milestone or repository scope.";

/** Failed or partial relationship reads never authorize a worker. */
export function issueEligibility(
  read: IssueWorkRead,
): "eligible" | "closed" | "blocked" | "unknown" {
  if (!read.parentComplete || !read.subIssuesComplete || !read.blockersComplete) return "unknown";
  if (read.state !== "open") return "closed";
  return read.blockedBy.some((blocker) => blocker.state === "open") ? "blocked" : "eligible";
}
