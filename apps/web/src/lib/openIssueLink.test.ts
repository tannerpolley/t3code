import { expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./openIssueLink";

const hosts = new Set(["github.com", "github.example.com"]);

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
