import { expect, it } from "vite-plus/test";

import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";

import { knownIssueHosts, parseIssueUrl } from "./openIssueLink";

const hosts = new Set(["github.com", "github.example.com", "forge.example:3000"]);

it("reads GitHub issue pages and leaves every other link alone", () => {
  expect(parseIssueUrl("https://github.com/Acme/web/issues/12", hosts)).toEqual({
    host: "github.com",
    repository: "Acme/web",
    number: 12,
  });
  expect(
    parseIssueUrl("https://github.example.com/acme/web/issues/3#issuecomment-1", hosts),
  ).toEqual({
    host: "github.example.com",
    repository: "acme/web",
    number: 3,
  });
  expect(parseIssueUrl("https://forge.example:3000/acme/web/issues/7", hosts)).toEqual({
    host: "forge.example:3000",
    repository: "acme/web",
    number: 7,
  });
  expect(parseIssueUrl("https://forge.example:3001/acme/web/issues/7", hosts)).toBeNull();
  // Pull requests, issue sub-pages, other forges and non-web schemes stay ordinary links.
  expect(parseIssueUrl("https://github.com/acme/web/pull/12", hosts)).toBeNull();
  expect(
    parseIssueUrl("https://github.com/acme/web/issues/12/linked_closing_reference", hosts),
  ).toBeNull();
  expect(parseIssueUrl("https://codeberg.org/acme/web/issues/12", hosts)).toBeNull();
  // A lookalike host is not a GitHub host.
  expect(parseIssueUrl("https://github.com.example.net/acme/web/issues/12", hosts)).toBeNull();
  expect(parseIssueUrl("javascript://github.com/acme/web/issues/12", hosts)).toBeNull();
  expect(parseIssueUrl("https://github.com/acme/web/issues/0", hosts)).toBeNull();
});

it("opens Forgejo issue links in T3, matching the host with its port", () => {
  const identity: RepositoryIdentity = {
    provider: SourceControlProviderKind.make("forgejo"),
    canonicalKey: "forge.example:3000/owner/repo",
    displayName: "owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://forge.example:3000/owner/repo",
    },
  };
  const issueHosts = knownIssueHosts([
    { repositoryIdentity: identity },
    {
      repositoryIdentity: {
        ...identity,
        provider: SourceControlProviderKind.make("github"),
        canonicalKey: "github.example/owner/repo",
      },
    },
  ]);
  expect([...issueHosts]).toEqual(["github.com", "forge.example:3000", "github.example"]);
  expect(parseIssueUrl("https://forge.example:3000/owner/repo/issues/1", issueHosts)).toEqual({
    host: "forge.example:3000",
    repository: "owner/repo",
    number: 1,
  });
  expect(parseIssueUrl("https://forge.example/owner/repo/issues/1", issueHosts)).toBeNull();
});
