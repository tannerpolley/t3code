import type {
  EnvironmentId,
  IssueListState,
  IssueRepositorySummary,
  IssueSummary,
} from "@t3tools/contracts";

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

export type IssueRepositoryTarget = IssueRepositorySummary & {
  readonly environmentId: EnvironmentId;
};

export function repositoryKey(host: string, repository: string): string {
  return `${host.trim().toLowerCase()}/${repository.trim().toLowerCase()}`;
}

/**
 * Merges each environment's repositories in environment order; a repository reachable from two
 * environments is read through the first. Most recently pushed repositories come first.
 */
export function mergeIssueRepositoryTargets(
  answers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly repositories: ReadonlyArray<IssueRepositorySummary>;
  }>,
): IssueRepositoryTarget[] {
  const seen = new Set<string>();
  const targets: IssueRepositoryTarget[] = [];
  for (const answer of answers) {
    for (const repository of answer.repositories) {
      const key = repositoryKey(repository.host, repository.repository);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ ...repository, environmentId: answer.environmentId });
    }
  }
  return targets.toSorted(
    (left, right) =>
      (right.pushedAt ?? "").localeCompare(left.pushedAt ?? "") ||
      left.repository.localeCompare(right.repository),
  );
}

/** The open view skips repositories whose open issue and pull request count is zero. */
export function visibleIssueRepositoryTargets(
  targets: ReadonlyArray<IssueRepositoryTarget>,
  filter: { readonly host: string | undefined; readonly state: IssueListState },
): IssueRepositoryTarget[] {
  const host = filter.host?.trim().toLowerCase();
  return targets.filter(
    (target) =>
      (host === undefined || target.host === host) &&
      (filter.state === "all" || target.openIssuesAndPullRequests > 0),
  );
}
