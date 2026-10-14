import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { issueProgress } from "./IssueStateIcon";

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
  expect(issueProgress({ state: "closed", blockedBy: [blocker("open")] })).toBe("closed");
  expect(
    issueProgress({ state: "open", blockedBy: [blocker("open")], liveWork: [work("working")] }),
  ).toBe("blocked");
  expect(issueProgress({ state: "open", blockedBy: [blocker("closed")] })).toBe("open");
  expect(issueProgress({ state: "open", liveWork: [work("waiting_on_you")] })).toBe("in_progress");
  expect(issueProgress({ state: "open", liveWork: [work("idle")] })).toBe("open");
  expect(issueProgress({ state: "open", projects: [project("In Progress")] })).toBe("in_progress");
  expect(issueProgress({ state: "open", projects: [project("Todo")] })).toBe("open");
});
