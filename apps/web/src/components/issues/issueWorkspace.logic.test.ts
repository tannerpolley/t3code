import type { IssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterAndSortIssues } from "./issueWorkspace.logic";

const issue = (
  number: number,
  title: string,
  overrides: Partial<IssueSummary> = {},
): IssueSummary => ({
  number,
  title,
  url: `https://github.com/acme/app/issues/${number}`,
  state: "open",
  stateReason: null,
  author: { login: "author", avatarUrl: null },
  assignees: [],
  labels: [],
  milestone: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: `2026-09-${String(20 + number).padStart(2, "0")}T00:00:00Z`,
  commentCount: 0,
  ...overrides,
});

describe("issue workspace filtering", () => {
  const rows = [
    issue(1, "Documentation", { labels: [{ name: "docs", color: null }] }),
    issue(2, "Release blocker", {
      assignees: [{ login: "octocat", avatarUrl: null }],
      milestone: {
        number: 1,
        title: "v1",
        state: "open",
        dueAt: null,
        url: "https://github.com/acme/app/milestone/1",
        openCount: 1,
        closedCount: 0,
      },
    }),
  ];

  it("searches metadata and combines milestone and assignment filters", () => {
    expect(
      filterAndSortIssues(rows, {
        query: "octocat v1",
        milestone: "with",
        assignee: "assigned",
        sort: "updated",
      }).map((row) => row.number),
    ).toEqual([2]);
    expect(
      filterAndSortIssues(rows, {
        query: "docs",
        milestone: "without",
        assignee: "unassigned",
        sort: "updated",
      }).map((row) => row.number),
    ).toEqual([1]);
  });

  it("supports the workspace issue sort choices", () => {
    const filters = { query: "", milestone: "all" as const, assignee: "all" as const };
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "updated" }).map((row) => row.number),
    ).toEqual([2, 1]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "oldest" }).map((row) => row.number),
    ).toEqual([1, 2]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "number" }).map((row) => row.number),
    ).toEqual([2, 1]);
    expect(
      filterAndSortIssues(rows, { ...filters, sort: "title" }).map((row) => row.title),
    ).toEqual(["Documentation", "Release blocker"]);
  });
});
