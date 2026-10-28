import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";
import { issueRepositoryOf } from "./issueRepositoryOf.ts";

it("addresses GitHub and Forgejo origins, retaining ports and rejecting other providers", () => {
  const identity: RepositoryIdentity = {
    provider: SourceControlProviderKind.make("forgejo"),
    canonicalKey: "forge.example:3000/upstream/repo",
    displayName: "upstream/repo",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "https://forge.example:3000/upstream/repo",
    },
    origin: { canonicalKey: "forge.example:3000/owner/repo", displayName: "owner/repo" },
  };
  expect(issueRepositoryOf(identity)).toEqual({
    host: "forge.example:3000",
    repository: "owner/repo",
  });
  expect(
    issueRepositoryOf({
      ...identity,
      provider: SourceControlProviderKind.make("github"),
      canonicalKey: "github.example/upstream/repo",
    }),
  ).toEqual({ host: "github.example", repository: "owner/repo" });
  expect(
    issueRepositoryOf({ ...identity, provider: SourceControlProviderKind.make("gitlab") }),
  ).toBeNull();
  expect(issueRepositoryOf(null)).toBeNull();
});
