import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type IssueWorkStatusResult,
  type IssueWorkStartResult,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { findIssueProject, issueWorkPresentation } from "./issueWork.ts";

const rootThreadId = ThreadId.make("root");
const workerId = ThreadId.make("worker");
const status: IssueWorkStatusResult = {
  issue: { host: "github.com", repository: "owner/repo", number: 8 },
  rootThreadId,
  threadId: null,
  status: null,
  publishing: "absent",
};
const accepted: IssueWorkStartResult = {
  rootThreadId,
  issueThreadId: null,
  status: "queued_preparing",
  createdRoot: false,
};

describe("issue work presentation", () => {
  it("does not label a repository owner as this issue's worker before a start", () => {
    expect(issueWorkPresentation(status).threadId).toBeNull();
    expect(issueWorkPresentation(status).label).toBeNull();
  });

  it("shows accepted queued work immediately and opens the root until a worker exists", () => {
    expect(issueWorkPresentation(null, accepted)).toMatchObject({
      threadId: rootThreadId,
      isWorker: false,
      label: "Queued / preparing",
    });
    expect(issueWorkPresentation({ ...status, status: "queued_preparing" })).toMatchObject({
      threadId: rootThreadId,
      isWorker: false,
    });
  });

  it("uses the current server worker instead of the initially accepted worker", () => {
    expect(
      issueWorkPresentation(
        { ...status, threadId: workerId, status: "waiting_on_sub_issues" },
        { ...accepted, issueThreadId: ThreadId.make("historical") },
      ),
    ).toMatchObject({ threadId: workerId, isWorker: true, label: "Waiting on sub-issues" });
  });

  it("does not reuse a historical worker when the server reports a queued request", () => {
    expect(
      issueWorkPresentation(
        { ...status, status: "queued_preparing" },
        { ...accepted, issueThreadId: workerId },
      ),
    ).toMatchObject({ threadId: rootThreadId, isWorker: false, label: "Queued / preparing" });
  });

  it("shows the completed worker while its GitHub comment is still pending", () => {
    expect(
      issueWorkPresentation({
        ...status,
        threadId: workerId,
        status: "done",
        publishing: "pending",
      }),
    ).toMatchObject({
      threadId: workerId,
      label: "Done",
      publishingLabel: "GitHub update pending",
    });
  });

  it("exposes publishing failures without replacing the worker's outcome", () => {
    expect(
      issueWorkPresentation({
        ...status,
        threadId: workerId,
        status: "interrupted",
        publishing: "failed",
      }),
    ).toMatchObject({
      label: "Interrupted",
      publishingLabel: "GitHub update failed · retry pending",
    });
    expect(
      issueWorkPresentation({ ...status, status: "working", publishing: "published" })
        .publishingLabel,
    ).toBeNull();
  });
});

it("matches projects in the selected environment, including fork and upstream", () => {
  const environmentId = EnvironmentId.make("selected");
  const repositoryIdentity: RepositoryIdentity = {
    canonicalKey: "github.com/upstream/repo",
    provider: SourceControlProviderKind.make("github"),
    displayName: "upstream/repo",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "git@github.com:upstream/repo",
    },
    origin: { canonicalKey: "github.com/owner/repo", displayName: "owner/repo" },
  };
  const projects = [
    {
      id: ProjectId.make("remote"),
      environmentId: EnvironmentId.make("other"),
      repositoryIdentity,
    },
    { id: ProjectId.make("first"), environmentId, repositoryIdentity },
    { id: ProjectId.make("preferred"), environmentId, repositoryIdentity },
  ];
  const issue = { environmentId, host: "github.com", repository: "Owner/Repo" };
  expect(findIssueProject(projects, issue, null)?.id).toBe("first");
  expect(findIssueProject(projects, issue, ProjectId.make("preferred"))?.id).toBe("preferred");
  expect(findIssueProject(projects, { ...issue, repository: "upstream/repo" }, null)?.id).toBe(
    "first",
  );
  expect(findIssueProject(projects, { ...issue, host: "different.test" }, null)).toBeNull();
});
