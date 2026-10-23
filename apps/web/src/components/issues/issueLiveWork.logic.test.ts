import { expect, it } from "vite-plus/test";
import {
  RunId,
  EnvironmentId,
  ThreadId,
  type IssueListResult,
  type IssueStatusBatchResult,
  type IssueSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { makeThreadFixture } from "~/test-fixtures";
import { createLiveIssueWorkOverlay, indexIssueWork } from "./issueLiveWork.logic";
import { issueProgress } from "./IssueStateIcon";
import { issueRoadmap } from "./issueRoadmap.logic";

const overlay = createLiveIssueWorkOverlay();
const environmentId = EnvironmentId.make("environment-test");
const withLiveIssueWork = (list: IssueListResult, shells: Parameters<typeof indexIssueWork>[0]) =>
  overlay.list(list, environmentId, indexIssueWork(shells));
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
      closingPullRequests: [],
    },
  ],
};
const root = makeThreadFixture({ linkedIssue });
const { linkedIssue: _linkedIssue, ...unlinkedRoot } = root;
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

const section = (value: IssueListResult) =>
  issueRoadmap(scope, [], value.issues).find((section) => section.rows.length > 0)?.id;

it("follows a linked parent's sidebar status, including questions and approvals", () => {
  const workingRoot = { ...root, runtime: running.runtime };
  expect(section(withLiveIssueWork(list, [root]))).toBe("paused");
  expect(section(withLiveIssueWork(list, [workingRoot]))).toBe("in-progress");
  for (const waiting of [
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "user_input" as const },
  ]) {
    expect(section(withLiveIssueWork(list, [{ ...workingRoot, ...waiting }]))).toBe("in-progress");
  }
  // A settled parent waiting for its subagent is not blue in the sidebar.
  expect(section(withLiveIssueWork(list, [root, running]))).toBe("paused");
  expect(section(withLiveIssueWork(list, [{ ...workingRoot, archivedAt: root.updatedAt }]))).toBe(
    "ready",
  );
  const stopped = withLiveIssueWork(list, []);
  expect(section(stopped)).toBe("ready");
  const foreign = { ...workingRoot, linkedIssue: { ...linkedIssue, host: "enterprise.test" } };
  expect(withLiveIssueWork(list, [foreign])).toBe(stopped);
});

it("keeps unrelated issue and list objects identical across unrelated shell updates", () => {
  const unrelated = { ...unlinkedRoot, id: ThreadId.make("unrelated") };
  const many = {
    ...list,
    issues: Array.from({ length: 1000 }, (_, index) => ({ ...list.issues[0]!, number: index + 1 })),
  };
  const first = withLiveIssueWork(many, [root, unrelated]);
  const second = withLiveIssueWork(many, [root, { ...unrelated, runtime: running.runtime }]);
  expect(second).toBe(first);
  expect(second.issues.every((issue, index) => issue === first.issues[index])).toBe(true);
  const changed = withLiveIssueWork(many, [{ ...root, runtime: running.runtime }, unrelated]);
  expect(changed.issues[42]).not.toBe(first.issues[42]);
  expect(changed.issues.filter((issue, index) => issue !== first.issues[index])).toHaveLength(1);
});

it("the Linked issue summary derives the same live status as the issue list", () => {
  const issue = {
    ...list.issues[0]!,
    liveWork: [
      {
        threadId: root.id,
        title: "cached",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        status: "idle" as const,
      },
    ],
  };
  const working = { ...root, runtime: running.runtime };
  expect(
    issueProgress(overlay.summary(issue, scope, environmentId, indexIssueWork([working]))),
  ).toBe("in_progress");
  expect(issueProgress(overlay.summary(issue, scope, environmentId, indexIssueWork([root])))).toBe(
    "paused",
  );
});

it("preserves an older server row and count even when its thread has PRs", () => {
  const { closingPullRequests: _, ...oldIssue } = list.issues[0]!;
  const old = {
    ...list,
    issues: [
      {
        ...oldIssue,
        pullRequestCount: 3,
        liveWork: [
          {
            threadId: root.id,
            title: "cached",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            status: "idle" as const,
          },
        ],
      },
    ],
  };
  const result = withLiveIssueWork(old, [{ ...root, pullRequests: [pr] }]);
  expect(result).toBe(old);
  expect(
    overlay.summary(
      old.issues[0]!,
      scope,
      environmentId,
      indexIssueWork([{ ...root, pullRequests: [pr] }]),
    ),
  ).toBe(old.issues[0]);
  expect(result.issues[0]?.pullRequestCount).toBe(3);
  expect(result.issues[0]?.pullRequests).toBeUndefined();
});

it("leaves older-server inherited work settled when an unlinked child runs", () => {
  const { closingPullRequests: _, ...oldIssue } = list.issues[0]!;
  const old = {
    ...list,
    issues: [
      {
        ...oldIssue,
        liveWork: [root, running].map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          status: "idle" as const,
        })),
      },
    ],
  };
  const result = withLiveIssueWork(old, [root, running]);
  expect(result).toBe(old);
  expect(section(result)).toBe("paused");
  expect(
    issueProgress(
      overlay.summary(old.issues[0]!, scope, environmentId, indexIssueWork([root, running])),
    ),
  ).toBe("paused");
});

it("combines closing PRs with linked threads' PRs, deduplicates identity and follows streamed PR state", () => {
  const closing = {
    ...list,
    issues: [
      {
        ...list.issues[0]!,
        closingPullRequests: [
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
  expect(section(review)).toBe("paused");
  expect(
    section(
      withLiveIssueWork(closing, [
        { ...thread, pullRequests: [{ ...pr, snapshot: { ...pr.snapshot!, state: "merged" } }] },
      ]),
    ),
  ).toBe("paused");
  const blocked = {
    ...closing,
    issues: [
      { ...closing.issues[0]!, blockedBy: [{ ...scope, number: 9, state: "open" as const }] },
    ],
  };
  expect(section(withLiveIssueWork(blocked, [thread, running]))).toBe("blocked");
});

it("drops PRs from unlinked, dismissed and archived threads instead of retaining the cached union", () => {
  const pr = {
    ...scope,
    number: 10,
    url: "https://github.com/owner/repo/pull/10",
    title: "Fix",
    state: "open" as const,
    isDraft: false,
  };
  const link: ThreadPullRequestLink = {
    ...pr,
    source: "manual",
    linkedAt: list.fetchedAt,
    stack: null,
    snapshot: {
      ...pr,
      headBranch: "fix",
      baseBranch: "main",
      updatedAt: null,
      syncedAt: list.fetchedAt,
    },
  };
  const thread = { ...root, pullRequests: [link] };
  const source = {
    ...list,
    issues: [{ ...list.issues[0]!, closingPullRequests: [], pullRequests: [pr] }],
  };
  expect(section(withLiveIssueWork(source, [thread]))).toBe("paused");
  // The PR association drops; a still-linked idle thread keeps the issue Paused.
  for (const [changed, expected] of [
    [{ ...unlinkedRoot, pullRequests: thread.pullRequests }, "ready"],
    [{ ...thread, archivedAt: root.updatedAt }, "ready"],
    [{ ...thread, pullRequests: [{ ...link, source: "stack-dismissed" as const }] }, "paused"],
  ] as const) {
    const result = withLiveIssueWork(source, [changed]);
    expect(result.issues[0]?.pullRequests).toEqual([]);
    expect(section(result)).toBe(expected);
  }
  // Merely observing a closing PR never associates the observing thread's activity.
  const observed = { ...unlinkedRoot, pullRequests: thread.pullRequests, runtime: running.runtime };
  const closing = { ...source, issues: [{ ...source.issues[0]!, closingPullRequests: [pr] }] };
  expect(section(withLiveIssueWork(closing, [observed]))).toBe("paused");
});

it("counts a directly linked subagent, but inherited children do not make a settled parent run", () => {
  const inherited = {
    ...list,
    issues: [
      {
        ...list.issues[0]!,
        liveWork: [
          {
            threadId: root.id,
            title: "Root",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            status: "idle" as const,
            inherited: false,
          },
          {
            threadId: running.id,
            title: "Child",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            status: "working" as const,
            inherited: true,
          },
        ],
      },
    ],
  };
  expect(section(withLiveIssueWork(inherited, [root, running]))).toBe("paused");
  expect(section(withLiveIssueWork(list, [{ ...running, linkedIssue }]))).toBe("in-progress");
});

it("keeps identical repository and thread IDs on separate environments apart", () => {
  const otherEnvironment = EnvironmentId.make("ENVIRONMENT-test");
  const other = { ...root, runtime: running.runtime, environmentId: otherEnvironment };
  const index = indexIssueWork([root, other]);
  expect(section(overlay.list(list, environmentId, index))).toBe("paused");
  expect(section(overlay.list(list, otherEnvironment, index))).toBe("in-progress");
});

it("overlays ordinary work from compact provenance when the managed thread is idle", () => {
  const ordinary = {
    ...running,
    lineage: { rootThreadId: running.id, parentThreadId: null, relationshipToParent: null },
  };
  const status: IssueStatusBatchResult[number] = {
    host: scope.host,
    nodeId: linkedIssue.nodeId,
    state: "open",
    stateReason: null,
    blockedBy: [],
    pullRequests: [],
    closingPullRequests: [],
    liveWork: [
      { threadId: root.id, inherited: false, status: "idle" },
      { threadId: ordinary.id, inherited: false, status: "idle" },
    ],
  };
  const summary = { ...status, number: linkedIssue.number };
  const index = indexIssueWork([root, ordinary]);
  const badge = overlay.summary(summary, scope, environmentId, index);
  const pane = overlay.summary(
    {
      ...list.issues[0]!,
      liveWork: status.liveWork!.map((work) => ({
        ...work,
        title: "cached",
        branch: null,
        worktreePath: null,
        pullRequests: [],
      })),
    },
    scope,
    environmentId,
    index,
  );
  expect(issueProgress(badge)).toBe("in_progress");
  expect(issueProgress(badge)).toBe(issueProgress(pane));
  expect(
    issueProgress(overlay.summary(summary, scope, environmentId, indexIssueWork([root]))),
  ).toBe("paused");
});

it("overlays compact sidebar status with the same live work and PR observations", () => {
  const status: IssueStatusBatchResult[number] & Pick<IssueSummary, "number" | "liveWork"> = {
    host: scope.host,
    nodeId: linkedIssue.nodeId,
    number: linkedIssue.number,
    state: "open",
    stateReason: null,
    blockedBy: [],
    pullRequests: [{ ...scope, number: pr.number, state: "open", updatedAt: list.fetchedAt }],
  };
  const summary = { ...status, closingPullRequests: status.pullRequests };
  const working = { ...root, runtime: running.runtime };
  const progress = (shells: Parameters<typeof indexIssueWork>[0]) =>
    issueProgress(overlay.summary(summary, scope, environmentId, indexIssueWork(shells)));
  expect(progress([working])).toBe("in_progress");
  expect(progress([root])).toBe("paused");
  expect(
    progress([
      {
        ...root,
        pullRequests: [
          {
            ...pr,
            snapshot: { ...pr.snapshot!, state: "merged", updatedAt: "2026-10-16T00:00:00Z" },
          },
        ],
      },
    ]),
  ).toBe("paused");
  expect(
    issueProgress(
      overlay.summary(
        { ...summary, state: "closed" as const },
        scope,
        environmentId,
        indexIssueWork([working]),
      ),
    ),
  ).toBe("completed");
});

it("retains archived worker and PR details on closed issues while preserving their closed state", () => {
  const source = {
    ...list,
    issues: list.issues.map((issue) => ({ ...issue, state: "closed" as const })),
  };
  const thread = {
    ...root,
    hasPendingApprovals: true,
    archivedAt: root.updatedAt,
    branch: "fix",
    worktreePath: "/repo/worker",
    pullRequests: [pr],
  };
  const result = withLiveIssueWork(source, [thread]);
  expect(result.issues[0]?.liveWork?.[0]).toMatchObject({
    threadId: root.id,
    branch: "fix",
    worktreePath: "/repo/worker",
    status: "idle",
  });
  expect(result.issues[0]?.pullRequests?.[0]?.number).toBe(pr.number);
  expect(issueProgress(result.issues[0]!)).toBe("completed");
});

it("preserves server checkout existence for matching paths and drops it when a worker moves", () => {
  const thread = { ...root, worktreePath: "/repo/.worktrees/worker" };
  const source = {
    ...list,
    issues: list.issues.map((issue) => ({
      ...issue,
      state: "closed" as const,
      liveWork: [
        {
          threadId: thread.id,
          title: thread.title,
          branch: thread.branch,
          pullRequests: [],
          status: "idle" as const,
          worktreePath: thread.worktreePath,
          worktreeExists: true,
        },
      ],
    })),
  };
  expect(withLiveIssueWork(source, [thread]).issues[0]?.liveWork?.[0]?.worktreeExists).toBe(true);
  expect(
    withLiveIssueWork(source, [{ ...thread, worktreePath: "/repo/.worktrees/moved" }]).issues[0]
      ?.liveWork?.[0]?.worktreeExists,
  ).toBeUndefined();
  const removed = {
    ...source,
    issues: source.issues.map((issue) => ({
      ...issue,
      liveWork: issue.liveWork.map((work) => ({ ...work, worktreeExists: false })),
    })),
  };
  expect(withLiveIssueWork(removed, [thread]).issues[0]?.liveWork?.[0]?.worktreeExists).toBe(false);
});
