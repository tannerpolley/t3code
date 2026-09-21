import type { IssueSummary } from "@t3tools/contracts";

export type IssueSort = "updated" | "oldest" | "number" | "title";
export type IssueMilestoneFilter = "all" | "with" | "without";
export type IssueAssigneeFilter = "all" | "assigned" | "unassigned";

export interface IssueWorkspaceFilters {
  readonly query: string;
  readonly milestone: IssueMilestoneFilter;
  readonly assignee: IssueAssigneeFilter;
  readonly sort: IssueSort;
}

function searchableText(issue: IssueSummary): string {
  return [
    issue.number,
    issue.title,
    issue.milestone?.title,
    issue.author?.login,
    ...issue.assignees.map((actor) => actor.login),
    ...issue.labels.map((label) => label.name),
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterAndSortIssues(
  issues: readonly IssueSummary[],
  filters: IssueWorkspaceFilters,
): IssueSummary[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return issues
    .filter((issue) => {
      if (terms.length > 0) {
        const text = searchableText(issue);
        if (!terms.every((term) => text.includes(term))) return false;
      }
      if (filters.milestone === "with" && issue.milestone === null) return false;
      if (filters.milestone === "without" && issue.milestone !== null) return false;
      if (filters.assignee === "assigned" && issue.assignees.length === 0) return false;
      if (filters.assignee === "unassigned" && issue.assignees.length > 0) return false;
      return true;
    })
    .toSorted((left, right) => {
      switch (filters.sort) {
        case "oldest":
          return left.updatedAt.localeCompare(right.updatedAt) || left.number - right.number;
        case "number":
          return right.number - left.number;
        case "title":
          return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        case "updated":
          return right.updatedAt.localeCompare(left.updatedAt) || right.number - left.number;
      }
    });
}
