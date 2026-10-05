import type { IssueMilestone, IssueSummary, RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ISSUE_FILTER_PREFERENCES } from "../issues/issueWorkspace.logic";
import { threadIssueGroups, threadIssueRepository } from "./ThreadDetailsIssueRows";

const identity = (overrides: Partial<RepositoryIdentity>): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/frontend",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/frontend",
  },
  provider: "github",
  owner: "acme",
  name: "frontend",
  ...overrides,
});

describe("threadIssueRepository", () => {
  it("lists issues for a github.com repository", () => {
    expect(threadIssueRepository(identity({}))).toEqual({
      host: "github.com",
      repository: "acme/frontend",
    });
  });

  it("lists the fork's issues when origin is a fork of upstream", () => {
    const upstream = identity({
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "git@github.com:acme/frontend",
      },
    });
    expect(threadIssueRepository({ ...upstream, originRepository: "me/frontend" })).toEqual({
      host: "github.com",
      repository: "me/frontend",
    });
    expect(threadIssueRepository(upstream)?.repository).toBe("acme/frontend");
  });

  it("skips repositories the issue browser cannot read", () => {
    expect(threadIssueRepository(null)).toBeNull();
    expect(threadIssueRepository(identity({ provider: "gitlab" }))).toBeNull();
    expect(
      threadIssueRepository(identity({ canonicalKey: "github.example.com/acme/frontend" })),
    ).toBeNull();
    expect(
      threadIssueRepository({
        canonicalKey: "github.com/acme",
        locator: identity({}).locator,
        provider: "github",
      }),
    ).toBeNull();
  });
});

const milestone = (number: number, title: string): IssueMilestone => ({
  number,
  title,
  state: "open",
  dueAt: null,
  url: `https://github.com/acme/frontend/milestone/${number}`,
  openCount: 0,
  closedCount: 0,
});

const issue = (
  number: number,
  inMilestone: IssueMilestone | null,
  state: IssueSummary["state"] = "open",
): IssueSummary => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/frontend/issues/${number}`,
  state,
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone: inMilestone,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: `2026-09-2${number}T00:00:00Z`,
  commentCount: 0,
});

describe("threadIssueGroups", () => {
  const beta = milestone(2, "Beta");
  const alpha = milestone(1, "Alpha");
  const issues = [issue(1, null), issue(2, beta), issue(3, alpha), issue(4, alpha, "closed")];

  it("groups open issues by milestone, no milestone last, cut across groups", () => {
    const view = threadIssueGroups(issues, DEFAULT_ISSUE_FILTER_PREFERENCES, 2);
    expect(view.groups.map((group) => [group.title, group.issues.map((i) => i.number)])).toEqual([
      ["Alpha", [3]],
      ["Beta", [2]],
    ]);
    expect(view).toMatchObject({ total: 3, hidden: 1 });
  });

  it("reads closed issues and nothing when both states are off", () => {
    const closed = { ...DEFAULT_ISSUE_FILTER_PREFERENCES, open: false, closed: true };
    expect(threadIssueGroups(issues, closed, 5).groups.flatMap((g) => g.issues)).toEqual([
      issues[3],
    ]);
    expect(threadIssueGroups(issues, { ...closed, closed: false }, 5).total).toBe(0);
  });
});
