import { expect, it } from "vite-plus/test";

import { parseIssueUrl } from "./openIssueLink";

it("reads GitHub issue pages and leaves every other link alone", () => {
  expect(parseIssueUrl("https://github.com/Acme/web/issues/12")).toEqual({
    host: "github.com",
    repository: "Acme/web",
    number: 12,
  });
  expect(parseIssueUrl("https://github.example.com/acme/web/issues/3#issuecomment-1")).toEqual({
    host: "github.example.com",
    repository: "acme/web",
    number: 3,
  });
  // Pull requests, issue sub-pages, other forges and non-web schemes stay ordinary links.
  expect(parseIssueUrl("https://github.com/acme/web/pull/12")).toBeNull();
  expect(
    parseIssueUrl("https://github.com/acme/web/issues/12/linked_closing_reference"),
  ).toBeNull();
  expect(parseIssueUrl("https://codeberg.org/acme/web/issues/12")).toBeNull();
  expect(parseIssueUrl("javascript://github.com/acme/web/issues/12")).toBeNull();
  expect(parseIssueUrl("https://github.com/acme/web/issues/0")).toBeNull();
});
