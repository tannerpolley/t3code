import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { issueSurface } from "~/rightPanelStore";
import { issueOriginFor, rememberIssueOrigin } from "./issuePullRequestOrigin";

it("returns to the opening issue only for the same pull request on the same host and server", () => {
  const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("t") };
  const issue = issueSurface({ host: "github.com", repository: "acme/web", number: 7 });
  const pr = { environmentId: "env", repository: "acme/web", number: 12 };
  rememberIssueOrigin(threadRef, { ...pr, host: "github.com" }, issue);

  expect(issueOriginFor(threadRef, { ...pr, host: "GitHub.com" }, [issue.id])).toBe(issue);
  // A tab from a server that does not name hosts still finds it.
  expect(issueOriginFor(threadRef, { ...pr, host: undefined }, [issue.id])).toBe(issue);
  // The same repository and number on an Enterprise host, or read from another server, is another PR.
  expect(issueOriginFor(threadRef, { ...pr, host: "github.example.com" }, [issue.id])).toBeNull();
  expect(
    issueOriginFor(threadRef, { ...pr, environmentId: "other", host: "github.com" }, [issue.id]),
  ).toBeNull();
  // Once the issue tab is closed there is nothing to go back to.
  expect(issueOriginFor(threadRef, { ...pr, host: "github.com" }, [])).toBeNull();
});
