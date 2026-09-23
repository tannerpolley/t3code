import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadIssueRepository } from "./ThreadDetailsIssueRows";

const identity = (overrides: Partial<RepositoryIdentity>): RepositoryIdentity => ({
  canonicalKey: "github.com/acme/frontend",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/frontend",
  },
  provider: "github",
  owner: "acme",
  name: "frontend",
  ...overrides,
});

describe("threadIssueRepository", () => {
  it("lists issues for a github.com repository", () => {
    expect(threadIssueRepository(identity({}))).toEqual({
      host: "github.com",
      repository: "acme/frontend",
    });
  });

  it("skips repositories the issue browser cannot read", () => {
    expect(threadIssueRepository(null)).toBeNull();
    expect(threadIssueRepository(identity({ provider: "gitlab" }))).toBeNull();
    expect(
      threadIssueRepository(identity({ canonicalKey: "github.example.com/acme/frontend" })),
    ).toBeNull();
    expect(
      threadIssueRepository({
        canonicalKey: "github.com/acme",
        locator: identity({}).locator,
        provider: "github",
      }),
    ).toBeNull();
  });
});
