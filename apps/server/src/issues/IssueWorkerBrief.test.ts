import { describe, expect, it } from "vite-plus/test";

import { issueWorkerBrief } from "./IssueWorkerBrief.ts";

const issue = {
  host: "github.com",
  repository: "tannerpolley/t3code",
  repositoryId: "12",
  id: "107",
  nodeId: "12/7",
  number: 7,
  title: "Fix validation",
  url: "https://github.com/tannerpolley/t3code/issues/7",
};

describe("managed issue worker delivery", () => {
  it.each([false, true])(
    "hands the fork's local branch to the orchestrator (opt-in: %s)",
    (optIn) => {
      const brief = issueWorkerBrief(issue, optIn);
      expect(brief).toContain("fresh read-only reviewer");
      expect(brief).toContain("exact commit SHA");
      expect(brief).toContain("The repository orchestrator owns full validation and publication.");
      expect(brief).not.toContain("you publish and merge");
    },
  );

  it("honors worker publication authority for an opted-in repository", () => {
    const other = { ...issue, repository: "acme/app", url: "https://github.com/acme/app/issues/7" };
    expect(issueWorkerBrief(other, true)).toContain("publish and merge after checks pass");
    expect(issueWorkerBrief(other, false)).toContain("publishing retain separate approval");
  });
});
