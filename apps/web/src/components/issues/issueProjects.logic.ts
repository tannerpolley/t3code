import type { RepositoryIssueSummary } from "@t3tools/contracts";

/** With multiple Projects, the earliest known Priority option takes precedence. */
export function issuePriorityRank(issue: RepositoryIssueSummary) {
  let rank = Number.POSITIVE_INFINITY;
  for (const project of issue.projects ?? []) {
    if (project.priority?.rank != null) rank = Math.min(rank, project.priority.rank);
  }
  return rank;
}
