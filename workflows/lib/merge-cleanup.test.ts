import { describe, expect, it } from "vite-plus/test";
import { completionState, namedGitHubIssues } from "./merge-cleanup.ts";

describe("merge cleanup issues", () => {
  it("finds local and other repository issue references and ignores examples and PR URLs", () => {
    expect(
      namedGitHubIssues({
        host: "github.com",
        repository: "Owner/Repo",
        title: "Change for #7",
        body: "Fixes OWNER/Repo#7, other/project#12, and https://github.com/OWNER/Repo/issues/18. See https://github.com/owner/repo/pull/20. Example: `#99`.",
      }),
    ).toEqual([
      "https://github.com/owner/repo/issues/7",
      "https://github.com/other/project/issues/12",
      "https://github.com/owner/repo/issues/18",
    ]);
  });

  it("uses the tracker's Done status or its completed resolution", () => {
    const completed = { name: "Completed", category: "closed", closeReason: "completed" } as const;
    const done = { name: "Done", category: "closed" } as const;
    const cancelled = {
      name: "Cancelled",
      category: "closed",
      closeReason: "not-planned",
    } as const;
    expect(completionState([completed, done, cancelled])).toEqual(done);
    expect(completionState([cancelled, completed])).toEqual(completed);
    expect(completionState([cancelled])).toBeUndefined();
    const closed = { category: "closed", name: "Closed" } as const;
    expect(completionState([closed])).toEqual(closed);
  });
});
