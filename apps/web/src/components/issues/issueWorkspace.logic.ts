import type {
  EnvironmentId,
  IssueListState,
  IssueRepositorySummary,
  IssueSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The issue list's Filter menu, saved per browser. Each flag is a positive "show" choice, so an
 * unchecked box always hides something. `pinned` holds repository keys that always show, whatever the
 * repository choices say.
 */
export const IssueFilterPreferences = Schema.Struct({
  open: Schema.Boolean,
  closed: Schema.Boolean,
  archived: Schema.Boolean,
  forks: Schema.Boolean,
  empty: Schema.Boolean,
  public: Schema.Boolean,
  private: Schema.Boolean,
  personal: Schema.Boolean,
  organizations: Schema.Boolean,
  milestone: Schema.Literals(["all", "with", "without"]),
  assignee: Schema.Literals(["all", "assigned", "unassigned"]),
  sort: Schema.Literals(["updated", "oldest", "number", "title"]),
  pinned: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type IssueFilterPreferences = typeof IssueFilterPreferences.Type;
export type IssueSort = IssueFilterPreferences["sort"];
export type IssueMilestoneFilter = IssueFilterPreferences["milestone"];
export type IssueAssigneeFilter = IssueFilterPreferences["assignee"];
export type IssueStateFilter = "open" | "closed" | "all";

export const DEFAULT_ISSUE_FILTER_PREFERENCES: IssueFilterPreferences = {
  open: true,
  closed: false,
  archived: false,
  forks: false,
  empty: false,
  public: true,
  private: true,
  personal: true,
  organizations: true,
  milestone: "all",
  assignee: "all",
  sort: "updated",
  pinned: [],
};

/** How many Filter menu choices differ from the defaults; sorting and pins are not filters. */
export function changedIssueFilterCount(preferences: IssueFilterPreferences): number {
  return (Object.keys(DEFAULT_ISSUE_FILTER_PREFERENCES) as Array<keyof IssueFilterPreferences>)
    .filter((key) => key !== "sort" && key !== "pinned")
    .filter((key) => preferences[key] !== DEFAULT_ISSUE_FILTER_PREFERENCES[key]).length;
}

export function issueStateFilter(preferences: IssueFilterPreferences): IssueStateFilter | null {
  if (preferences.open && preferences.closed) return "all";
  if (preferences.open) return "open";
  return preferences.closed ? "closed" : null;
}

/** GitHub lists open or all issues, so closed-only reads all and keeps the closed ones. */
export function issueListStateFor(state: IssueStateFilter): IssueListState {
  return state === "open" ? "open" : "all";
}

export interface IssueWorkspaceFilters {
  readonly query: string;
  readonly state: IssueStateFilter;
  readonly milestone: IssueMilestoneFilter;
  readonly assignee: IssueAssigneeFilter;
  readonly sort: IssueSort;
}

function searchableText(issue: IssueSummary, repository: string): string {
  return [
    repository,
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

/** The search also matches the repository name, so one box finds repositories and issues. */
export function filterAndSortIssues(
  issues: readonly IssueSummary[],
  filters: IssueWorkspaceFilters,
  repository = "",
): IssueSummary[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return issues
    .filter((issue) => {
      if (filters.state !== "all" && issue.state !== filters.state) return false;
      if (terms.length > 0) {
        const text = searchableText(issue, repository);
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

/** Repository-level Filter choices: archived, fork, visibility and owner kind. Pins bypass them. */
export function repositoryShown(
  target: IssueRepositorySummary,
  preferences: IssueFilterPreferences,
): boolean {
  return (
    preferences.pinned.includes(repositoryKey(target.host, target.repository)) ||
    ((preferences.archived || !target.isArchived) &&
      (preferences.forks || !target.isFork) &&
      (target.isPrivate ? preferences.private : preferences.public) &&
      (target.ownerIsOrganization ? preferences.organizations : preferences.personal))
  );
}

/**
 * GitHub's open count covers open issues and pull requests, so zero means the open view has
 * nothing to read there.
 */
export function repositoryKnownEmpty(
  target: IssueRepositorySummary,
  state: IssueStateFilter,
): boolean {
  return state === "open" && target.openIssuesAndPullRequests === 0;
}

/**
 * Whether a shown repository stays in the tree. Loading, failed and partly loaded repositories
 * stay; an empty one needs the Empty filter or a pin, and no search or narrowing hiding its issues.
 */
export function repositoryListed(
  entry: { readonly count: number; readonly settled: boolean; readonly pinned: boolean },
  preferences: IssueFilterPreferences,
  narrowed: boolean,
): boolean {
  return !entry.settled || entry.count > 0 || ((preferences.empty || entry.pinned) && !narrowed);
}

export interface IssueOwnerGroup<T> {
  readonly key: string;
  readonly host: string;
  readonly owner: string;
  readonly isOrganization: boolean;
  readonly isViewer: boolean;
  readonly repositories: T[];
}

/**
 * Groups repositories under their owner: the signed-in accounts first, then owners
 * alphabetically. Repositories keep their incoming order.
 */
export function groupRepositoriesByOwner<
  T extends Pick<IssueRepositorySummary, "host" | "owner" | "ownerIsOrganization">,
>(repositories: readonly T[], viewerLogins: readonly string[]): IssueOwnerGroup<T>[] {
  const viewers = new Set(viewerLogins.map((login) => login.toLowerCase()));
  const groups = new Map<string, IssueOwnerGroup<T>>();
  for (const repository of repositories) {
    const key = repositoryKey(repository.host, repository.owner);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        host: repository.host,
        owner: repository.owner,
        isOrganization: repository.ownerIsOrganization,
        isViewer: viewers.has(repository.owner.toLowerCase()),
        repositories: [],
      };
      groups.set(key, group);
    }
    group.repositories.push(repository);
  }
  return [...groups.values()].toSorted(
    (left, right) =>
      Number(right.isViewer) - Number(left.isViewer) ||
      left.owner.localeCompare(right.owner, undefined, { sensitivity: "base" }) ||
      left.host.localeCompare(right.host),
  );
}
