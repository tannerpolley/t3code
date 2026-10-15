import { expect, it } from "vite-plus/test";
import {
  RunId,
  ThreadId,
  type IssueListResult,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { makeThreadFixture } from "~/test-fixtures";
import { withLiveIssueWork } from "./issueLiveWork.logic";
import { issueRoadmap } from "./issueRoadmap.logic";

const scope = { host: "github.com", repository: "owner/repo" };
const linkedIssue = {
  ...scope,
  number: 43,
  repositoryId: "repo",
  id: "43",
  nodeId: "I_43",
  title: "Fix",
  url: "https://github.com/owner/repo/issues/43",
};
const list: IssueListResult = {
  repository: scope,
  viewer: null,
  fetchedAt: "2026-10-15T00:00:00Z",
  milestones: [],
  nextCursor: null,
  issuesComplete: true,
  milestonesComplete: true,
  issues: [
    {
      number: 43,
      title: "Fix",
      url: linkedIssue.url,
      state: "open",
      stateReason: null,
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      blockedBy: [],
      relationshipsComplete: true,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
      commentCount: 0,
    },
  ],
};
const root = makeThreadFixture({ linkedIssue });
const running = makeThreadFixture({
  id: ThreadId.make("child"),
  lineage: { rootThreadId: root.id, parentThreadId: root.id, relationshipToParent: "subagent" },
  runtime: {
    status: "running",
    activeRunId: RunId.make("run"),
    providerInstanceId: root.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: root.updatedAt,
  },
});
const section = (value: IssueListResult) =>
  issueRoadmap(scope, [], value.issues).find((section) => section.rows.length > 0)?.id;

it("moves a newly linked thread and its descendants with the sidebar stream, without a GitHub refresh", () => {
  expect(section(withLiveIssueWork(list, [root]))).toBe("ready");
  const working = withLiveIssueWork(list, [root, running]);
  expect(section(working)).toBe("in-progress");
  for (const waiting of [
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "user_input" as const },
  ]) {
    expect(section(withLiveIssueWork(working, [root, { ...running, ...waiting }]))).toBe("ready");
  }
  expect(
    section(
      withLiveIssueWork(working, [
        root,
        { ...running, runtime: { ...running.runtime!, status: "idle" } },
      ]),
    ),
  ).toBe("ready");
  expect(
    section(withLiveIssueWork(working, [root, { ...running, archivedAt: root.updatedAt }])),
  ).toBe("ready");
  expect(section(withLiveIssueWork(working, []))).toBe("ready");
  const foreign = { ...root, linkedIssue: { ...linkedIssue, host: "enterprise.test" } };
  expect(withLiveIssueWork(list, [foreign]).issues[0]?.liveWork).toEqual([]);
});

it("combines closing PRs with linked threads' PRs, deduplicates identity and follows streamed PR state", () => {
  const pr: ThreadPullRequestLink = {
    ...scope,
    number: 10,
    url: "https://github.com/owner/repo/pull/10",
    source: "manual",
    linkedAt: list.fetchedAt,
    stack: null,
    snapshot: {
      state: "open",
      title: "Fix",
      headBranch: "fix",
      baseBranch: "main",
      isDraft: true,
      updatedAt: list.fetchedAt,
      syncedAt: list.fetchedAt,
    },
  };
  const closing = {
    ...list,
    issues: [
      {
        ...list.issues[0]!,
        pullRequests: [
          {
            ...scope,
            number: 10,
            url: pr.url,
            title: "Fix",
            state: "open" as const,
            isDraft: true,
          },
        ],
      },
    ],
  };
  const thread = {
    ...root,
    pullRequests: [
      pr,
      { ...pr, number: 11, url: "https://github.com/owner/repo/pull/11", snapshot: null },
      { ...pr, number: 12, source: "stack-dismissed" as const },
    ],
  };
  const review = withLiveIssueWork(closing, [thread]);
  expect(review.issues[0]?.pullRequests?.map((pr) => pr.number)).toEqual([10, 11]);
  expect(section(review)).toBe("in-review");
  expect(
    section(
      withLiveIssueWork(review, [
        { ...thread, pullRequests: [{ ...pr, snapshot: { ...pr.snapshot!, state: "merged" } }] },
      ]),
    ),
  ).toBe("ready");
  const blocked = {
    ...closing,
    issues: [
      { ...closing.issues[0]!, blockedBy: [{ ...scope, number: 9, state: "open" as const }] },
    ],
  };
  expect(section(withLiveIssueWork(blocked, [thread, running]))).toBe("blocked");
});
