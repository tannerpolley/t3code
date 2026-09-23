import { EnvironmentId, type IssueRepositorySummary, type IssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ISSUE_FILTER_PREFERENCES,
  changedIssueFilterCount,
  filterAndSortIssues,
  groupRepositoriesByOwner,
  issueListStateFor,
  issueStateFilter,
  mergeIssueRepositoryTargets,
  repositoryKnownEmpty,
  repositoryListed,
  repositoryShown,
} from "./issueWorkspace.logic";

const issue = (
  number: number,
  title: string,
  overrides: Partial<IssueSummary> = {},
): IssueSummary => ({
  number,
  title,
  url: `https://github.com/acme/app/issues/${number}`,
  state: "open",
  stateReason: null,
  author: { login: "author", avatarUrl: null },
  assignees: [],
  labels: [],
  milestone: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: `2026-09-${String(20 + number).padStart(2, "0")}T00:00:00Z`,
  commentCount: 0,
  ...overrides,
});

describe("issue workspace filtering", () => {
  const rows = [
    issue(1, "Documentation", { labels: [{ name: "docs", color: null }] }),
    issue(2, "Release blocker", {
      assignees: [{ login: "octocat", avatarUrl: null }],
      milestone: {
        number: 1,
        title: "v1",
        state: "open",
        dueAt: null,
        url: "https://github.com/acme/app/milestone/1",
        openCount: 1,
        closedCount: 0,
      },
    }),
  ];

  it("searches metadata and combines milestone and assignment filters", () => {
    expect(
      filterAndSortIssues(rows, {
        query: "octocat v1",
        state: "all",
        milestone: "with",
        assignee: "assigned",
        sort: "updated",
      }).map((row) => row.number),
    ).toEqual([2]);
    expect(
      filterAndSortIssues(rows, {
        query: "docs",
        state: "all",
        milestone: "without",
        assignee: "unassigned",
        sort: "updated",
      }).map((row) => row.number),
    ).toEqual([1]);
  });

  it("supports the workspace issue sort choices", () => {
    const filters = {
      query: "",
      state: "all" as const,
      milestone: "all" as const,
      assignee: "all" as const,
    };
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "updated" }).map((row) => row.number),
    ).toEqual([2, 1]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "oldest" }).map((row) => row.number),
    ).toEqual([1, 2]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "number" }).map((row) => row.number),
    ).toEqual([2, 1]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "title" }).map((row) => row.title),
    ).toEqual(["Documentation", "Release blocker"]);
  });

  it("keeps only closed issues when Closed is shown without Open", () => {
    const preferences = { ...DEFAULT_ISSUE_FILTER_PREFERENCES, open: false, closed: true };
    const state = issueStateFilter(preferences)!;
    expect(issueListStateFor(state)).toBe("all");
    const closed = issue(3, "Shipped", { state: "closed" });
    expect(
      filterAndSortIssues([...rows, closed], {
        query: "",
        state,
        milestone: "all",
        assignee: "all",
        sort: "updated",
      }).map((row) => row.number),
    ).toEqual([3]);
    expect(issueStateFilter({ ...preferences, closed: false })).toBeNull();
  });

  it("matches the repository name so one search finds a repository's issues", () => {
    const filters = {
      query: "acme/app",
      state: "all" as const,
      milestone: "all" as const,
      assignee: "all" as const,
      sort: "number" as const,
    };
    expect(filterAndSortIssues(rows, filters, "acme/app").map((row) => row.number)).toEqual([2, 1]);
    expect(filterAndSortIssues(rows, filters, "acme/other")).toEqual([]);
  });
});

const repository = (
  name: string,
  overrides: Partial<IssueRepositorySummary> = {},
): IssueRepositorySummary => ({
  host: "github.com",
  repository: name,
  owner: name.split("/")[0]!,
  ownerIsOrganization: false,
  isPrivate: false,
  isArchived: false,
  isFork: false,
  openIssuesAndPullRequests: 1,
  pushedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

describe("issue repository targets", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");

  it("reads a repository shared by two environments through the first, newest push first", () => {
    const targets = mergeIssueRepositoryTargets([
      {
        environmentId: local,
        repositories: [
          repository("me/old", { pushedAt: "2026-01-01T00:00:00Z" }),
          repository("me/app"),
        ],
      },
      {
        environmentId: remote,
        repositories: [repository("Me/App"), repository("org/tool", { pushedAt: null })],
      },
    ]);

    expect(targets.map((target) => [target.repository, target.environmentId])).toEqual([
      ["me/app", local],
      ["me/old", local],
      ["org/tool", remote],
    ]);
  });

  it("applies the archived, fork, visibility and owner filters together", () => {
    const shown = (target: IssueRepositorySummary, changes = {}) =>
      repositoryShown(target, { ...DEFAULT_ISSUE_FILTER_PREFERENCES, ...changes });
    const archivedFork = repository("me/old", { isArchived: true, isFork: true });
    const privateOrg = repository("org/app", { isPrivate: true, ownerIsOrganization: true });

    expect(shown(repository("me/app"))).toBe(true);
    expect(shown(archivedFork)).toBe(false);
    expect(shown(archivedFork, { archived: true })).toBe(false);
    expect(shown(archivedFork, { archived: true, forks: true })).toBe(true);
    expect(shown(privateOrg)).toBe(true);
    expect(shown(privateOrg, { private: false })).toBe(false);
    expect(shown(privateOrg, { organizations: false })).toBe(false);
    expect(shown(repository("me/app"), { personal: false })).toBe(false);
    expect(changedIssueFilterCount({ ...DEFAULT_ISSUE_FILTER_PREFERENCES, forks: true })).toBe(1);
    expect(changedIssueFilterCount({ ...DEFAULT_ISSUE_FILTER_PREFERENCES, sort: "title" })).toBe(0);
  });

  it("treats a zero open count as empty only in the open view", () => {
    const quiet = repository("me/quiet", { openIssuesAndPullRequests: 0 });
    expect(repositoryKnownEmpty(quiet, "open")).toBe(true);
    expect(repositoryKnownEmpty(quiet, "all")).toBe(false);
    expect(repositoryKnownEmpty(repository("me/busy"), "open")).toBe(false);
  });

  it("lists an empty repository only with Empty shown and nothing narrowing the list", () => {
    const preferences = DEFAULT_ISSUE_FILTER_PREFERENCES;
    const empty = { count: 0, settled: true };
    expect(repositoryListed({ count: 0, settled: false }, preferences, true)).toBe(true);
    expect(repositoryListed({ count: 2, settled: true }, preferences, true)).toBe(true);
    expect(repositoryListed(empty, preferences, false)).toBe(false);
    expect(repositoryListed(empty, { ...preferences, empty: true }, false)).toBe(true);
    expect(repositoryListed(empty, { ...preferences, empty: true }, true)).toBe(false);
  });

  it("groups repositories under the signed-in account first, then owners alphabetically", () => {
    const groups = groupRepositoriesByOwner(
      [
        repository("zeta/tool", { ownerIsOrganization: true }),
        repository("Me/new"),
        repository("acme/site", { ownerIsOrganization: true }),
        repository("me/old"),
      ],
      ["me"],
    );
    expect(
      groups.map((group) => [
        group.owner,
        group.isViewer,
        group.isOrganization,
        group.repositories.map((target) => target.repository),
      ]),
    ).toEqual([
      ["Me", true, false, ["Me/new", "me/old"]],
      ["acme", false, true, ["acme/site"]],
      ["zeta", false, true, ["zeta/tool"]],
    ]);
  });
});
