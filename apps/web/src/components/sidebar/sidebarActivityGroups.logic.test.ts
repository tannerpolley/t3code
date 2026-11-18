import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveSidebarActivityGroup } from "./sidebarActivityGroups.logic";

const at = "2026-11-18T12:00:00.000Z";
const openPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  source: "agent",
  linkedAt: at,
  snapshot: {
    state: "open",
    title: "Improve checkout",
    headBranch: "checkout",
    baseBranch: "main",
    isDraft: false,
    updatedAt: at,
    syncedAt: at,
  },
  stack: null,
};
type Thread = Parameters<typeof resolveSidebarActivityGroup>[0];
const thread: Thread = {
  interactionMode: "default",
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestRun: null,
  runtime: null,
  pullRequests: [openPullRequest],
};
const runtime = (status: NonNullable<Thread["runtime"]>["status"]) => ({
  status,
  lastError: null,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  updatedAt: at,
});

describe("Activity groups", () => {
  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { runtime: runtime("failed") },
  ])("puts owner attention ahead of an open pull request (%j)", (state) => {
    expect(resolveSidebarActivityGroup({ ...thread, ...state })).toBe("needs-you");
  });

  it.each(["preparing", "queued", "running", "waiting"] as const)(
    "keeps an open pull request out of review while the thread is %s",
    (status) => {
      expect(resolveSidebarActivityGroup({ ...thread, runtime: runtime(status) })).toBeNull();
    },
  );

  it("puts an idle thread with any visible open pull request in review", () => {
    const merged: ThreadPullRequestLink = {
      ...openPullRequest,
      number: 41,
      snapshot: { ...openPullRequest.snapshot!, state: "merged" },
    };
    expect(
      resolveSidebarActivityGroup({ ...thread, pullRequests: [merged, openPullRequest] }),
    ).toBe("ready-for-review");
    expect(
      resolveSidebarActivityGroup({
        ...thread,
        pullRequests: [
          merged,
          { ...openPullRequest, number: 43, snapshot: null },
          { ...openPullRequest, number: 44, source: "stack-dismissed" },
        ],
      }),
    ).toBeNull();
  });
});
