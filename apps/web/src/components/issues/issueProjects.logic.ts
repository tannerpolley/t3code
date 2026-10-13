import type { IssueSummary } from "@t3tools/contracts";

/** Project names disambiguate chips only when an issue belongs to multiple accessible Projects. */
export function issueProjectChips(projects: IssueSummary["projects"] = []) {
  const chips: Array<{ key: string; label: string }> = [];
  for (const project of projects) {
    const prefix = projects.length > 1 ? `${project.title}: ` : "";
    if (project.status !== null) {
      chips.push({ key: `${project.id}:status`, label: `${prefix}Status: ${project.status}` });
    }
    if (project.priority !== null) {
      chips.push({
        key: `${project.id}:priority`,
        label: `${prefix}Priority: ${project.priority.name}`,
      });
    }
  }
  return chips;
}

/** With multiple Projects, the earliest known Priority option takes precedence. */
export function issuePriorityRank(issue: IssueSummary) {
  let rank = Number.POSITIVE_INFINITY;
  for (const project of issue.projects ?? []) {
    if (project.priority?.rank != null) rank = Math.min(rank, project.priority.rank);
  }
  return rank;
}
