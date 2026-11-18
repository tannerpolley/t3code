import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  issueReferenceCopyTarget,
  issueComposerPrompt,
  issueImplementDestination,
} from "./issueDetailActions.logic";
import { handoffPrompt } from "./issueDetailActions.logic";

const threadRef = { environmentId: EnvironmentId.make("host"), threadId: ThreadId.make("thread") };
const issue = {
  number: 44,
  title: "Match PR panes",
  url: "https://github.com/owner/repo/issues/44",
};

describe("issue menu", () => {
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
  const input = {
    environmentId: threadRef.environmentId,
    rootThreadId,
    hasParent: false,
    paused: false,
  };

  it("targets the registered root's composer for a top-level issue, independently of the current thread", () => {
    expect(issueImplementDestination(input)).toEqual({ threadRef: rootRef, disabledReason: null });
  });

  it("disables sub-issues and points to the parent issue's worker", () => {
    expect(issueImplementDestination({ ...input, hasParent: true })).toEqual({
      threadRef: null,
      disabledReason: "Implement sub-issues from the parent issue's worker",
    });
  });

  it("disables implementation while repository work is paused", () => {
    expect(issueImplementDestination({ ...input, paused: true })).toEqual({
      threadRef: null,
      disabledReason: "Repository work is paused; resume it in Project settings",
    });
  });

  it("disables implementation without a root and points to Start agent", () => {
    expect(issueImplementDestination({ ...input, rootThreadId: null })).toEqual({
      threadRef: null,
      disabledReason: "No orchestrator for this repository; use Start agent",
    });
  });

  it("preserves the delegation prompt and existing composer text", () => {
    const prompt = issueComposerPrompt("implement", issue);
    expect(prompt).toBe(
      `Implement this issue: #44: Match PR panes\n\n${issue.url}\n\nRead the issue and its latest comments, then delegate it with delegate_task using the issue argument, following the repository's model roles.`,
    );
    expect(
      handoffPrompt({ prompt: "Existing instructions", lastHandoffPrompt: undefined }, prompt),
    ).toBe(`Existing instructions\n\n${prompt}`);
  });
});

it("copies the selected issue URL with issue-specific feedback, and releases the generic command when no issue is open", () => {
  expect(
    issueReferenceCopyTarget({
      tracker: "github",
      host: "github.example.com",
      scope: "owner/repo",
      key: "44",
    }),
  ).toEqual({
    kind: "issue",
    value: "https://github.example.com/owner/repo/issues/44",
    clipboardTarget: "issue link",
    successTitle: "Issue link copied",
    failureTitle: "Failed to copy issue link",
  });
  expect(issueReferenceCopyTarget(null)).toBeNull();
  expect(issueReferenceCopyTarget({ tracker: "linear", scope: "ENG", key: "ENG-1" })).toBeNull();
});
