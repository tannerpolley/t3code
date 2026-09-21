import type { IssueMilestone, IssueSummary } from "@t3tools/contracts";

export interface IssueGroup {
  id: string;
  title: string;
  milestone: IssueMilestone | null;
  issues: IssueSummary[];
}
/** Official milestones stay visible even when empty; unassigned issues are always last. */
export function groupIssuesByMilestone(
  milestones: readonly IssueMilestone[],
  issues: readonly IssueSummary[],
): IssueGroup[] {
  const official = new Map(milestones.map((milestone) => [milestone.number, milestone]));
  const groups = new Map<number, IssueGroup>();
  for (const milestone of official.values()) {
    groups.set(milestone.number, {
      id: `milestone:${milestone.number}`,
      title: milestone.title,
      milestone,
      issues: [],
    });
  }
  const unassigned: IssueGroup = { id: "none", title: "No Milestone", milestone: null, issues: [] };
  const ordered = [...issues].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.number - left.number,
  );
  for (const issue of ordered) {
    const milestone = issue.milestone;
    if (milestone === null) {
      unassigned.issues.push(issue);
      continue;
    }
    let group = groups.get(milestone.number);
    if (!group) {
      group = {
        id: `milestone:${milestone.number}`,
        title: milestone.title,
        milestone,
        issues: [],
      };
      groups.set(milestone.number, group);
    }
    group.issues.push(issue);
  }
  const result = [...groups.values()].sort(
    (left, right) =>
      Number(official.has(right.milestone!.number)) -
        Number(official.has(left.milestone!.number)) ||
      left.title.localeCompare(right.title, "en", { sensitivity: "base" }) ||
      left.milestone!.number - right.milestone!.number,
  );
  if (unassigned.issues.length > 0) result.push(unassigned);
  return result;
}
