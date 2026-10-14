import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  RepositoryOrchestration,
  IssueWorkRequested,
  IssueWorkStartInput,
  RepositoryWorkInput,
} from "./issueWork.ts";

const decodeOwner = Schema.decodeUnknownSync(RepositoryOrchestration);
const decodeRequest = Schema.decodeUnknownSync(IssueWorkRequested);
const decodeStart = Schema.decodeUnknownSync(IssueWorkStartInput);
const decodeMilestone = Schema.decodeUnknownSync(RepositoryWorkInput);

describe("managed issue workspace compatibility", () => {
  it("loads old ownership and request rows while discarding their workspace choice", () => {
    const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
    const issue = {
      host: "github.com",
      repository: "owner/repo",
      repositoryId: "repo:1",
      id: "issue:8",
      nodeId: "node:8",
      number: 8,
      title: "Issue 8",
      url: "https://github.com/owner/repo/issues/8",
    };
    for (const workspace of ["project", "worktree"]) {
      const owner = decodeOwner({
        ...issue,
        projectId: "project:1",
        workspace,
        launchCommandId: "launch:1",
        revision: 1,
        paused: false,
        workerLimit: 4,
        publishStatusComments: true,
        publishCloseoutComments: true,
        milestones: [
          { number: 1, modelRoleId: "worker", workspace, status: "running", fingerprint: "" },
        ],
        suspendedIssues: [],
      });
      expect(owner).not.toHaveProperty("workspace");
      expect(owner.milestones[0]).not.toHaveProperty("workspace");
      expect(
        decodeRequest({
          requestId: "request:1",
          issue,
          rootThreadId: "root:1",
          issueThreadId: null,
          attemptKey: "first",
          modelSelection,
          workspace,
        }),
      ).not.toHaveProperty("workspace");
      const input = {
        ...issue,
        projectId: "project:1",
        modelRoleId: "worker",
        clientRequestId: "start:1",
        milestoneNumber: 1,
        workspace,
      };
      expect(decodeStart(input)).not.toHaveProperty("workspace");
      expect(decodeMilestone(input)).not.toHaveProperty("workspace");
    }
  });
});
