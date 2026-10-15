import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  canUnlinkIssue,
  issueReferenceCopyTarget,
  filterIssueComments,
  issueComposerPrompt,
  issueImplementDestination,
  issueMenuAvailability,
} from "./issueDetailActions.logic";
import { handoffPrompt } from "../pullRequest/pullRequestDetail.logic";

const threadRef = { environmentId: EnvironmentId.make("host"), threadId: ThreadId.make("thread") };
const issue = {
  number: 44,
  title: "Match PR panes",
  url: "https://github.com/owner/repo/issues/44",
};

describe("issue menu", () => {
  it("offers writes only with grants and the matching issue state, and needs a composer destination", () => {
    expect(
      issueMenuAvailability({
        linked: true,
        hasComposer: true,
        state: "open",
        canWrite: true,
        canUnlink: true,
      }),
    ).toEqual({ unlink: true, composer: true, close: true, reopen: false });
    expect(
      issueMenuAvailability({
        linked: false,
        hasComposer: false,
        state: "closed",
        canWrite: true,
        canUnlink: true,
      }),
    ).toEqual({ unlink: false, composer: false, close: false, reopen: true });
    expect(
      issueMenuAvailability({
        linked: true,
        hasComposer: true,
        state: "open",
        canWrite: false,
        canUnlink: false,
      }),
    ).toEqual({ unlink: false, composer: true, close: false, reopen: false });
  });

  it("unlinks only ordinary links belonging to this thread on this environment", () => {
    const summary = {
      liveWork: [
        {
          threadId: threadRef.threadId,
          title: "Thread",
          branch: null,
          worktreePath: null,
          pullRequests: [],
          status: "idle" as const,
          canUnlink: true,
        },
      ],
    };
    expect(canUnlinkIssue(summary, "host", threadRef)).toBe(true);
    expect(canUnlinkIssue(summary, "another-host", threadRef)).toBe(false);
    expect(canUnlinkIssue(summary, "host", null)).toBe(false);
    expect(
      canUnlinkIssue(
        { ...summary, liveWork: [{ ...summary.liveWork![0]!, canUnlink: false }] },
        "host",
        threadRef,
      ),
    ).toBe(false);
    expect(
      canUnlinkIssue(
        { ...summary, liveWork: [{ ...summary.liveWork![0]!, threadId: ThreadId.make("other") }] },
        "host",
        threadRef,
      ),
    ).toBe(false);
  });

  it("adds issue context for a question and preserves existing composer text", () => {
    const prompt = issueComposerPrompt("ask", issue);
    expect(prompt).toBe("#44: Match PR panes\n\nhttps://github.com/owner/repo/issues/44");
    expect(handoffPrompt({ prompt: "My question", lastHandoffPrompt: undefined }, prompt)).toBe(
      `My question\n\n${prompt}`,
    );
  });

  it("explains without requesting implementation", () => {
    expect(issueComposerPrompt("explain", issue)).toBe(
      `Explain this issue: #44: Match PR panes\n\n${issue.url}\n\nRead the issue and its latest comments. Explain the problem, intended outcome, and relevant code. Leave implementation for a separate request.`,
    );
    expect(issueComposerPrompt("ask", { ...issue, title: "" })).toContain("Untitled issue");
  });
});

describe("implementation composer routing", () => {
  const rootThreadId = ThreadId.make("root");
  const rootRef = { environmentId: threadRef.environmentId, threadId: rootThreadId };
  const currentThread = {
    environmentId: threadRef.environmentId,
    id: threadRef.threadId,
    lineage: {
      rootThreadId,
      parentThreadId: rootThreadId,
      relationshipToParent: "subagent" as const,
    },
  };
  const input = {
    environmentId: threadRef.environmentId,
    rootThreadId,
    currentThread,
    parentOwnerThreadId: null,
  };

  it("uses the current composer when the current thread is the registered root", () => {
    expect(
      issueImplementDestination({
        ...input,
        currentThread: {
          ...currentThread,
          id: rootThreadId,
          lineage: { rootThreadId, parentThreadId: null, relationshipToParent: null },
        },
      }),
    ).toEqual({ threadRef: rootRef, disabledReason: null });
  });

  it("routes an unrelated current thread to the registered root's composer", () => {
    expect(issueImplementDestination(input)).toEqual({ threadRef: rootRef, disabledReason: null });
  });

  it("disables implementation without a root and points to Start agent", () => {
    expect(issueImplementDestination({ ...input, rootThreadId: null })).toEqual({
      threadRef: null,
      disabledReason: "No orchestrator for this repository; use Start agent",
    });
  });

  it("uses the root's composer without a current thread", () => {
    expect(issueImplementDestination({ ...input, currentThread: null })).toEqual({
      threadRef: rootRef,
      disabledReason: null,
    });
  });

  it("allows the immediate parent's current owner within the registered root's lineage", () => {
    const parentInput = { ...input, parentOwnerThreadId: currentThread.id };
    expect(issueImplementDestination(parentInput)).toEqual({
      threadRef,
      disabledReason: null,
    });
    expect(
      issueImplementDestination({
        ...parentInput,
        currentThread: {
          ...currentThread,
          lineage: { ...currentThread.lineage, rootThreadId: ThreadId.make("retired-root") },
        },
      }).threadRef,
    ).toEqual(rootRef);
    expect(
      issueImplementDestination({
        ...parentInput,
        currentThread: { ...currentThread, environmentId: EnvironmentId.make("another-host") },
      }).threadRef,
    ).toEqual(rootRef);
  });
});

it("filters bot reports without hiding deleted authors or changing comment order", () => {
  const comments = [
    {
      author: { login: "review[bot]", avatarUrl: null },
      body: "Report",
      createdAt: "2026-10-15T00:00:00Z",
      url: "https://github.com/owner/repo/issues/44#issuecomment-1",
    },
    {
      author: null,
      body: "Deleted author",
      createdAt: "2026-10-15T01:00:00Z",
      url: "https://github.com/owner/repo/issues/44#issuecomment-2",
    },
  ];
  expect(filterIssueComments(comments, false)).toEqual([comments[1]]);
  expect(filterIssueComments(comments, true)).toBe(comments);
});

it("copies the selected issue URL with issue-specific feedback, and releases the generic command when no issue is open", () => {
  expect(
    issueReferenceCopyTarget({ host: "github.example.com", repository: "owner/repo", number: 44 }),
  ).toEqual({
    kind: "issue",
    value: "https://github.example.com/owner/repo/issues/44",
    clipboardTarget: "issue link",
    successTitle: "Issue link copied",
    failureTitle: "Failed to copy issue link",
  });
  expect(issueReferenceCopyTarget(null)).toBeNull();
});
