import { expect, it } from "vite-plus/test";
import type { IssuePullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import { issuePullRequests } from "./issuePullRequests.ts";

const github: IssuePullRequest = {
  host: "github.com",
  repository: "owner/repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  title: "Fix",
  state: "closed",
  isDraft: false,
  updatedAt: "2026-10-15T01:00:00Z",
};
const thread: ThreadPullRequestLink = {
  ...github,
  source: "manual",
  linkedAt: "2026-10-14T00:00:00Z",
  stack: null,
  snapshot: {
    title: "Fix",
    state: "open",
    isDraft: false,
    headBranch: "fix",
    baseBranch: "main",
    updatedAt: "2026-10-14T00:00:00Z",
    syncedAt: "2026-10-15T02:00:00Z",
  },
};
it("a stale thread snapshot cannot reopen a GitHub-closed pull request", () => {
  expect(issuePullRequests([github], [thread])[0]?.state).toBe("closed");
  expect(
    issuePullRequests(
      [github],
      [{ ...thread, snapshot: { ...thread.snapshot!, updatedAt: "2026-10-15T03:00:00Z" } }],
    )[0]?.state,
  ).toBe("open");
});
it("without comparable timestamps terminal states beat open in either source", () => {
  const { updatedAt: _updatedAt, ...undated } = github;
  expect(issuePullRequests([undated], [thread])[0]?.state).toBe("closed");
  expect(
    issuePullRequests(
      [{ ...github, state: "open" }],
      [{ ...thread, snapshot: { ...thread.snapshot!, updatedAt: null, state: "merged" } }],
    )[0]?.state,
  ).toBe("merged");
});
