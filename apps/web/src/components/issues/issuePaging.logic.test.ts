import { type IssueListResult, type IssueMilestone, type IssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { acceptIssueListPage } from "./issuePaging.logic";

const milestone: IssueMilestone = {
  number: 1,
  title: "Release",
  state: "open",
  dueAt: null,
  url: "https://github.com/acme/app/milestone/1",
  openCount: 1,
  closedCount: 0,
};

function issue(number: number, updatedAt: string, title = `Issue ${number}`): IssueSummary {
  return {
    number,
    title,
    url: `https://github.com/acme/app/issues/${number}`,
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

function result(
  issues: readonly IssueSummary[],
  nextCursor: string | null,
  fetchedAt: string,
): IssueListResult {
  return {
    repository: { host: "github.com", repository: "acme/app" },
    viewer: null,
    fetchedAt,
    issues,
    milestones: [milestone],
    nextCursor,
    issuesComplete: nextCursor === null,
    milestonesComplete: true,
  };
}

describe("issue list paging", () => {
  it("accumulates pages, keeps the newest duplicate, and preserves completion flags", () => {
    const first = acceptIssueListPage(null, {
      scopeKey: "env:project",
      generation: 1,
      cursor: null,
      result: result([issue(1, "2026-09-21T00:00:00Z")], "cursor-2", "2026-09-21T00:00:00Z"),
    });
    const second = acceptIssueListPage(first, {
      scopeKey: "env:project",
      generation: 1,
      cursor: "cursor-2",
      result: result(
        [issue(1, "2026-09-22T00:00:00Z", "New title"), issue(2, "2026-09-21T12:00:00Z")],
        null,
        "2026-09-22T00:00:00Z",
      ),
    });

    expect(second?.pageCount).toBe(2);
    expect(second?.issues.map((entry) => [entry.number, entry.title])).toEqual([
      [1, "New title"],
      [2, "Issue 2"],
    ]);
    expect(second?.nextCursor).toBeNull();
    expect(second?.issuesComplete).toBe(true);
  });

  it("ignores a late response from an older refresh generation", () => {
    const current = acceptIssueListPage(null, {
      scopeKey: "env:project",
      generation: 2,
      cursor: null,
      result: result([issue(1, "2026-09-22T00:00:00Z", "Fresh")], null, "2026-09-22T00:00:00Z"),
    });
    const stale = acceptIssueListPage(current, {
      scopeKey: "env:project",
      generation: 1,
      cursor: null,
      result: result([issue(1, "2026-09-20T00:00:00Z", "Stale")], null, "2026-09-20T00:00:00Z"),
    });

    expect(stale).toBe(current);
    expect(stale?.issues[0]?.title).toBe("Fresh");
  });

  it("rejects a non-first page from a new refresh generation", () => {
    const current = acceptIssueListPage(null, {
      scopeKey: "env:project",
      generation: 1,
      cursor: null,
      result: result([issue(1, "2026-09-21T00:00:00Z")], "cursor-2", "2026-09-21T00:00:00Z"),
    });
    const afterFailedRefresh = acceptIssueListPage(current, {
      scopeKey: "env:project",
      generation: 2,
      cursor: "cursor-2",
      result: result([issue(2, "2026-09-22T00:00:00Z")], null, "2026-09-22T00:00:00Z"),
    });

    expect(afterFailedRefresh).toBe(current);
  });

  it("rejects a repeated or out-of-order cursor", () => {
    const first = acceptIssueListPage(null, {
      scopeKey: "env:project",
      generation: 1,
      cursor: null,
      result: result([issue(1, "2026-09-21T00:00:00Z")], "cursor-2", "2026-09-21T00:00:00Z"),
    });
    const outOfOrder = acceptIssueListPage(first, {
      scopeKey: "env:project",
      generation: 1,
      cursor: "cursor-3",
      result: result([issue(3, "2026-09-21T00:00:00Z")], null, "2026-09-21T00:00:00Z"),
    });
    const second = acceptIssueListPage(first, {
      scopeKey: "env:project",
      generation: 1,
      cursor: "cursor-2",
      result: result([issue(2, "2026-09-21T00:00:00Z")], null, "2026-09-21T00:00:00Z"),
    });
    const repeated = acceptIssueListPage(second, {
      scopeKey: "env:project",
      generation: 1,
      cursor: "cursor-2",
      result: result([issue(4, "2026-09-21T00:00:00Z")], null, "2026-09-21T00:00:00Z"),
    });

    expect(outOfOrder).toBe(first);
    expect(repeated).toBe(second);
  });
});

it("accepts metadata-only live refreshes and removes issues that left an open page", () => {
  const initial = result(
    [{ ...issue(1, "2026-09-21T00:00:00Z"), blockedBy: [], liveWork: [] }],
    null,
    "2026-09-21T01:00:00Z",
  );
  const first = acceptIssueListPage(null, {
    scopeKey: "env:project",
    generation: 1,
    cursor: null,
    result: initial,
  });
  const refreshed = acceptIssueListPage(first, {
    scopeKey: "env:project",
    generation: 1,
    cursor: null,
    result: {
      ...initial,
      fetchedAt: "2026-09-21T02:00:00Z",
      issues: [
        {
          ...initial.issues[0]!,
          blockedBy: [{ host: "github.com", repository: "acme/app", number: 99, state: "closed" }],
        },
      ],
    },
  });
  expect(refreshed?.issues[0]?.blockedBy?.[0]?.state).toBe("closed");
  const closed = acceptIssueListPage(refreshed, {
    scopeKey: "env:project",
    generation: 1,
    cursor: null,
    result: { ...initial, fetchedAt: "2026-09-21T03:00:00Z", issues: [] },
  });
  expect(closed?.issues).toEqual([]);
});

it("refreshes previously loaded pages and drops obsolete continuations without mixing generations", () => {
  const first = acceptIssueListPage(null, {
    scopeKey: "env:project",
    generation: 1,
    cursor: null,
    result: result([issue(1, "2026-09-21T00:00:00Z")], "cursor-2", "2026-09-21T01:00:00Z"),
  });
  const second = acceptIssueListPage(first, {
    scopeKey: "env:project",
    generation: 1,
    cursor: "cursor-2",
    result: result([issue(2, "2026-09-21T00:00:00Z")], null, "2026-09-21T02:00:00Z"),
  });
  const updated = acceptIssueListPage(second, {
    scopeKey: "env:project",
    generation: 1,
    cursor: "cursor-2",
    result: result(
      [issue(2, "2026-09-21T00:00:00Z", "New dependency metadata")],
      null,
      "2026-09-21T03:00:00Z",
    ),
  });
  expect(updated?.issues.map((issue) => issue.title)).toEqual([
    "Issue 1",
    "New dependency metadata",
  ]);
  const complete = acceptIssueListPage(updated, {
    scopeKey: "env:project",
    generation: 1,
    cursor: null,
    result: result([issue(1, "2026-09-21T00:00:00Z")], null, "2026-09-21T04:00:00Z"),
  });
  expect(complete?.issues.map((issue) => issue.number)).toEqual([1]);
  expect(complete?.pageCount).toBe(1);
});
