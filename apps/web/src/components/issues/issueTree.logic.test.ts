import type { IssueMilestone, IssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupIssuesByMilestone } from "./issueTree.logic";

function milestone(number: number, title: string): IssueMilestone {
  return {
    number,
    title,
    state: "open",
    dueAt: null,
    url: `https://github.com/owner/repo/milestone/${number}`,
    openCount: 0,
    closedCount: 0,
  };
}

function issue(
  number: number,
  milestone: IssueMilestone | null,
  updatedAt = "2026-09-21T00:00:00Z",
): IssueSummary {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: "open",
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone,
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt,
    commentCount: 0,
  };
}

describe("milestone navigation", () => {
  it("keeps empty official groups before referenced groups and unassigned issues", () => {
    const zeta = milestone(1, "Zeta");
    const alpha = milestone(2, "alpha");
    const archived = { ...milestone(3, "A retired release"), state: "closed" as const };
    const groups = groupIssuesByMilestone(
      [zeta, alpha],
      [issue(4, archived), issue(5, null), issue(6, zeta)],
    );
    expect(
      groups.map((group) => [group.id, group.title, group.issues.map((row) => row.number)]),
    ).toEqual([
      ["milestone:2", "alpha", []],
      ["milestone:1", "Zeta", [6]],
      ["milestone:3", "A retired release", [4]],
      ["none", "No Milestone", [5]],
    ]);
  });

  it("uses milestone identity through a rename and keeps a real No Milestone separate", () => {
    const renamed = milestone(1, "Release");
    const sameTitle = milestone(2, "Release");
    const namedNoMilestone = milestone(3, "No Milestone");
    const groups = groupIssuesByMilestone(
      [renamed, sameTitle, namedNoMilestone],
      [
        issue(1, milestone(1, "Old name")),
        issue(2, sameTitle),
        issue(3, namedNoMilestone),
        issue(4, null),
      ],
    );
    expect(
      groups.map((group) => [group.id, group.title, group.issues.map((row) => row.number)]),
    ).toEqual([
      ["milestone:3", "No Milestone", [3]],
      ["milestone:1", "Release", [1]],
      ["milestone:2", "Release", [2]],
      ["none", "No Milestone", [4]],
    ]);
  });

  it("sorts issues by update time and then descending issue number", () => {
    const release = milestone(1, "Release");
    const groups = groupIssuesByMilestone(
      [release],
      [issue(2, release), issue(3, release), issue(1, release, "2026-09-22T00:00:00Z")],
    );
    expect(groups.map((group) => [group.id, group.issues.map((row) => row.number)])).toEqual([
      ["milestone:1", [1, 3, 2]],
    ]);
  });

  it("does not invent an unassigned group for an empty repository", () => {
    expect(groupIssuesByMilestone([], [])).toEqual([]);
    expect(
      groupIssuesByMilestone([milestone(1, "Future")], []).map((group) => group.title),
    ).toEqual(["Future"]);
  });
});

