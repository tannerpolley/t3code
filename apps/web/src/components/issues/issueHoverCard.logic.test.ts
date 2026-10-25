import type { IssueDetailResult, IssuePullRequest, IssueSummary } from "@t3tools/contracts";
import { resolveThreadPullRequestChains } from "@t3tools/client-runtime/thread-pull-requests";
import { expect, it } from "vite-plus/test";

import { issueHoverPullRequests } from "./issueHoverCard.logic";

const pr = (number: number, overrides: Partial<IssuePullRequest> = {}): IssuePullRequest => ({
  host: "github.com",
  repository: "acme/web",
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  state: "open",
  isDraft: false,
  ...overrides,
});
const issue = (pullRequests: IssuePullRequest[]): IssueSummary => ({
  number: 44,
  title: "Issue hover",
  url: "https://github.com/acme/web/issues/44",
  state: "open",
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  pullRequests,
});
const detail = (summary: IssueSummary, refs: IssuePullRequest[]): IssueDetailResult => ({
  repository: { host: "github.com", repository: "acme/web" },
  issue: summary,
  viewer: null,
  fetchedAt: summary.updatedAt,
  body: "",
  comments: [],
  linkedPullRequests: refs.map((ref) => ({
    ...ref,
    state: ref.state ?? "open",
    closesIssue: false,
  })),
});

it("merges mentions, closing and thread PRs by identity without losing terminal states", () => {
  const summary = issue([
    pr(1, { host: "GITHUB.COM", repository: "ACME/WEB" }),
    pr(2, { state: "merged" }),
    pr(3, { state: "closed" }),
  ]);
  const links = issueHoverPullRequests(
    summary,
    "github.com",
    detail(summary, [
      pr(1, { state: "merged" }),
      pr(2),
      pr(4, { isDraft: true }),
      pr(1, { repository: "acme/other", url: "https://github.com/acme/other/pull/1" }),
    ]),
  );
  expect(links).toHaveLength(5);
  expect(links.filter((link) => link.snapshot?.state === "merged")).toHaveLength(2);
  expect(links.find((link) => link.number === 3)?.snapshot?.state).toBe("closed");
  expect(links.find((link) => link.number === 4)?.snapshot?.isDraft).toBe(true);
  expect(links.find((link) => link.repository === "acme/other")?.url).toBe(
    "https://github.com/acme/other/pull/1",
  );
  expect(resolveThreadPullRequestChains(links).every((chain) => chain.layers.length === 1)).toBe(
    true,
  );
});

it("keeps row PRs before detail loads and preserves an unknown host state", () => {
  const links = issueHoverPullRequests(issue([pr(1, { state: null }), pr(2)]), "github.com", null);
  expect(links.map((link) => link.url)).toEqual([pr(1).url, pr(2).url]);
  expect(links[0]?.snapshot).toBeNull();
  expect(links[1]?.snapshot?.title).toBe("Change 2");
  expect(issueHoverPullRequests(issue([]), "github.com", null)).toEqual([]);
});
