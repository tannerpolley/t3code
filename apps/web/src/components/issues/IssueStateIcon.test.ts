import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { issueProgress, issueStatePresentation } from "./IssueStateIcon";

const blocker = (state: "open" | "closed") => ({
  host: "github.com",
  repository: "acme/repo",
  repositoryId: "1",
  id: "9",
  nodeId: "I_9",
  number: 9,
  title: "Blocker",
  url: "https://github.com/acme/repo/issues/9",
  state,
});
const work = (status: "working" | "waiting_on_you" | "idle") => ({
  threadId: ThreadId.make("thread"),
  title: "Worker",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  status,
});
const project = (status: string | null) => ({
  id: "P1",
  title: "Board",
  status,
  priority: null,
});

it("orders closed, then an open blocker, then work in progress, then open", () => {
  expect(issueProgress({ state: "closed", blockedBy: [blocker("open")] })).toBe("completed");
  expect(
    issueProgress({ state: "open", blockedBy: [blocker("open")], liveWork: [work("working")] }),
  ).toBe("blocked");
  expect(issueProgress({ state: "open", blockedBy: [blocker("closed")] })).toBe("open");
  expect(issueProgress({ state: "open", liveWork: [work("waiting_on_you")] })).toBe("open");
  expect(issueProgress({ state: "open", liveWork: [work("working")] })).toBe("in_progress");
  expect(issueProgress({ state: "open", liveWork: [work("idle")] })).toBe("open");
  expect(issueProgress({ state: "open", projects: [project("In Progress")] })).toBe("open");
  expect(issueProgress({ state: "open", projects: [project("Todo")] })).toBe("open");
});

it("splits closed issues the way GitHub closes them", () => {
  expect(issueProgress({ state: "closed", stateReason: "completed" })).toBe("completed");
  expect(issueProgress({ state: "closed", stateReason: null })).toBe("completed");
  expect(issueProgress({ state: "closed", stateReason: "not_planned" })).toBe("not_planned");
  expect(issueStatePresentation({ state: "closed", stateReason: "duplicate" }).label).toBe(
    "Closed as duplicate",
  );
  // A reopened issue is open again whatever its old reason said.
  expect(issueProgress({ state: "open", stateReason: "reopened" })).toBe("open");
});

it("puts open and draft PRs In review after running work, while blockers and closed issues win", () => {
  const pr = {
    host: "github.com",
    repository: "acme/repo",
    number: 42,
    title: "Fix",
    url: "https://github.com/acme/repo/pull/42",
    state: "open" as const,
    isDraft: false,
  };
  expect(issueProgress({ state: "open", pullRequests: [pr] })).toBe("in_review");
  expect(issueProgress({ state: "open", pullRequests: [{ ...pr, isDraft: true }] })).toBe(
    "in_review",
  );
  expect(issueProgress({ state: "open", pullRequests: [{ ...pr, state: "merged" }] })).toBe("open");
  expect(issueProgress({ state: "open", pullRequests: [{ ...pr, state: "closed" }] })).toBe("open");
  expect(issueProgress({ state: "open", pullRequests: [pr], liveWork: [work("working")] })).toBe(
    "in_progress",
  );
  expect(
    issueProgress({ state: "open", pullRequests: [pr], liveWork: [work("waiting_on_you")] }),
  ).toBe("in_review");
  expect(issueProgress({ state: "open", pullRequests: [pr], blockedBy: [blocker("open")] })).toBe(
    "blocked",
  );
  expect(issueProgress({ state: "closed", pullRequests: [pr], liveWork: [work("working")] })).toBe(
    "completed",
  );
});
