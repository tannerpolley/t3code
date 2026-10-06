import type { IssueWorkRead } from "@t3tools/contracts";

/** Failed or partial relationship reads never authorize a worker. */
export function issueEligibility(
  read: IssueWorkRead,
): "eligible" | "closed" | "blocked" | "unknown" {
  if (!read.parentComplete || !read.subIssuesComplete || !read.blockersComplete) return "unknown";
  if (read.state !== "open") return "closed";
  return read.blockedBy.some((blocker) => blocker.state === "open") ? "blocked" : "eligible";
}
