import { SourceControlProviderKind } from "@t3tools/contracts";
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
  provider: SourceControlProviderKind.make("github"),
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

  it("lists the fork's issues when origin is a fork of upstream", () => {
    const upstream = identity({
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "git@github.com:acme/frontend",
      },
    });
    expect(
      threadIssueRepository({
        ...upstream,
        origin: { canonicalKey: "github.com/me/frontend", displayName: "me/frontend" },
      }),
    ).toEqual({
      host: "github.com",
      repository: "me/frontend",
    });
    expect(threadIssueRepository(upstream)?.repository).toBe("acme/frontend");
  });

  it("skips repositories the issue browser cannot read", () => {
    expect(threadIssueRepository(null)).toBeNull();
    expect(
      threadIssueRepository(identity({ provider: SourceControlProviderKind.make("gitlab") })),
    ).toBeNull();
    expect(
      threadIssueRepository(identity({ canonicalKey: "github.example.com/acme/frontend" })),
    ).toBeNull();
    expect(
      threadIssueRepository({
        canonicalKey: "github.com/acme",
        locator: identity({}).locator,
        provider: SourceControlProviderKind.make("github"),
      }),
    ).toBeNull();
  });
});
