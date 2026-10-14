import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findIssueProject } from "./issueWorktree.logic";

describe("findIssueProject", () => {
  const environmentId = EnvironmentId.make("local");
  const fork: RepositoryIdentity = {
    canonicalKey: "github.com/acme/app",
    locator: { source: "git-remote", remoteName: "upstream", remoteUrl: "git@github.com:acme/app" },
    provider: "github",
    displayName: "acme/app",
    origin: { canonicalKey: "github.com/me/app", displayName: "me/app" },
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
