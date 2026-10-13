import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findIssueProject, issueWorktreeBranchName } from "./issueWorktree.logic";

describe("issueWorktreeBranchName", () => {
  it("slugs the title into one git-safe segment", () => {
    expect(issueWorktreeBranchName(42, "Fix: the `Sidebar` / folders!")).toBe(
      "issue-42-fix-the-sidebar-folders",
    );
  });
});

describe("findIssueProject", () => {
  const environmentId = EnvironmentId.make("local");
  const fork: RepositoryIdentity = {
    canonicalKey: "github.com/acme/app",
    locator: { source: "git-remote", remoteName: "upstream", remoteUrl: "git@github.com:acme/app" },
    provider: "github",
    displayName: "acme/app",
    originRepository: "me/app",
  };
  const projects = [
    { id: ProjectId.make("other"), environmentId, repositoryIdentity: null },
    { id: ProjectId.make("a"), environmentId, repositoryIdentity: fork },
    { id: ProjectId.make("b"), environmentId, repositoryIdentity: fork },
  ];

  it("matches the fork or its upstream, preferring the reader's project", () => {
    const issue = { environmentId, host: "github.com", repository: "Me/App" };
    expect(findIssueProject(projects, issue, null)?.id).toBe("a");
    expect(findIssueProject(projects, issue, ProjectId.make("b"))?.id).toBe("b");
    expect(findIssueProject(projects, { ...issue, repository: "acme/app" }, null)?.id).toBe("a");
    expect(findIssueProject(projects, { ...issue, repository: "acme/other" }, null)).toBeNull();
  });
});
