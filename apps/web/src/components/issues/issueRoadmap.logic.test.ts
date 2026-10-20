import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type IssueMilestone, type IssueSummary } from "@t3tools/contracts";
import { issueRoadmap, issueLiveStatus } from "./issueRoadmap.logic";

const scope = { host: "github.com", repository: "owner/repo" };
const ref = (number: number, state: "open" | "closed" = "open", repository = scope.repository) => ({
  ...scope,
  repository,
  number,
  state,
});
function issue(number: number, overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: "open",
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    commentCount: 0,
    blockedBy: [],
    parent: null,
    relationshipsComplete: true,
    ...overrides,
  };
}
const milestone = (number: number, title: string): IssueMilestone => ({
  number,
  title,
  state: "open",
  dueAt: null,
  url: `https://github.com/owner/repo/milestone/${number}`,
  openCount: 0,
  closedCount: 0,
});
const work = (status: "working" | "waiting_on_you" | "idle") => [
  {
    threadId: ThreadId.make("builder"),
    title: "Builder",
    branch: "feature",
    worktreePath: "/work/feature",
    pullRequests: [],
    status,
  },
];
const pr = (state: "open" | "merged" | "closed") => ({
  ...scope,
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  title: "Fix",
  state,
  isDraft: false,
});
const numbers = (rows: ReturnType<typeof issueRoadmap>[number]["rows"]) =>
  rows.map((row) => row.issue.number);

describe("live roadmap", () => {
  it("orders the acceptance chains and keeps every blocked issue behind its blockers within its section", () => {
    const sections = issueRoadmap(
      scope,
      [],
      [
        issue(435, { blockedBy: [ref(439)] }),
        issue(439, { blockedBy: [ref(423)] }),
        issue(434, { blockedBy: [ref(423)] }),
        issue(432, { blockedBy: [ref(431)] }),
        issue(431),
        issue(423),
      ],
    );
    expect(numbers(sections[3]!.rows)).toEqual([423, 431]);
    expect(numbers(sections[4]!.rows)).toEqual([432, 434, 439, 435]);
    const blocked = numbers(sections[4]!.rows);
    expect(blocked.indexOf(439)).toBeLessThan(blocked.indexOf(435));
  });
  it("orders an open child before its parent, ignores closed children and closed blockers, and excludes closed issues", () => {
    const sections = issueRoadmap(
      scope,
      [],
      [
        issue(1),
        issue(7, { parent: ref(1) }),
        issue(2, { blockedBy: [ref(99, "closed")] }),
        issue(5, { state: "closed", parent: ref(1) }),
      ],
    );
    expect(numbers(sections[3]!.rows)).toEqual([2, 7, 1]);
    expect(sections[4]!.rows).toEqual([]);
  });
  it("uses milestone group order, then Project Priority, then oldest issue number for available nodes", () => {
    const alpha = milestone(2, "Alpha"),
      zeta = milestone(1, "Zeta");
    const priority = (rank: number) => [
      { id: "project", title: "Project", status: null, priority: { name: "Priority", rank } },
    ];
    const sections = issueRoadmap(
      scope,
      [zeta, alpha],
      [
        issue(1),
        issue(2, { milestone: zeta, projects: priority(0) }),
        issue(9, { milestone: alpha, projects: priority(1) }),
        issue(8, { milestone: alpha, projects: priority(0) }),
        issue(7, { milestone: alpha, projects: priority(0) }),
        issue(3, { milestone: alpha }),
      ],
    );
    expect(numbers(sections[3]!.rows)).toEqual([7, 8, 9, 3, 2, 1]);
  });
  it("dependency order beats priority and milestone order in the same section", () => {
    const alpha = milestone(1, "Alpha"),
      zeta = milestone(2, "Zeta");
    const sections = issueRoadmap(
      scope,
      [alpha, zeta],
      [
        issue(2, {
          milestone: alpha,
          parent: null,
          liveWork: work("working"),
          projects: [{ id: "p", title: "P", status: null, priority: { name: "High", rank: 0 } }],
        }),
        // An open blocker would move #2 to Blocked; a child edge orders it within In progress.
        issue(3, { milestone: zeta, parent: ref(2), liveWork: work("working") }),
      ],
    );
    expect(numbers(sections[1]!.rows)).toEqual([3, 2]);
  });
  it("shows external and unloaded open blockers without giving an external issue number an ordering edge", () => {
    const sections = issueRoadmap(
      scope,
      [],
      [
        issue(1, { blockedBy: [ref(7, "open", "other/repo")] }),
        issue(2, { blockedBy: [ref(999)] }),
        issue(7, { blockedBy: [ref(1000)] }),
      ],
    );
    expect(numbers(sections[4]!.rows)).toEqual([1, 2, 7]);
  });
  it("numbers cycles deterministically, including child/blocker cycles and self edges, without badging their descendants", () => {
    const sections = issueRoadmap(
      scope,
      [],
      [
        issue(9, { parent: ref(4) }),
        issue(4, { blockedBy: [ref(9)], parent: ref(9) }),
        issue(2, { blockedBy: [ref(4)] }),
        issue(3, { blockedBy: [ref(3)] }),
        issue(1),
      ],
    );
    expect(numbers(sections[3]!.rows)).toEqual([1, 9]);
    expect(
      sections
        .flatMap((section) => section.rows)
        .filter((row) => row.cycle)
        .map((row) => row.issue.number)
        .sort((a, b) => a - b),
    ).toEqual([3, 4, 9]);
    expect(numbers(sections[4]!.rows)).toEqual([3, 4, 2]);
    expect(sections[4]!.rows.find((row) => row.issue.number === 2)?.cycle).toBe(false);
  });
  it("keeps only running agents In progress, open PRs In review, and blockers ahead of both", () => {
    const first = issueRoadmap(
      scope,
      [],
      [
        issue(1, { liveWork: work("working"), blockedBy: [ref(99)] }),
        issue(2, { liveWork: work("waiting_on_you") }),
        issue(3, { liveWork: work("idle") }),
        issue(4, { relationshipsComplete: false }),
        issue(5, { liveWork: work("idle"), blockedBy: [ref(98)] }),
        issue(6, { liveWork: work("idle"), relationshipsComplete: false }),
        issue(7, { liveWork: work("working") }),
        issue(8, { pullRequests: [pr("open")] }),
        issue(9, { pullRequests: [pr("merged")] }),
        issue(10, { pullRequests: [pr("open")], blockedBy: [ref(99)] }),
        issue(11, { pullRequests: [pr("open")], liveWork: work("working") }),
        issue(12, { pullRequests: [pr("open")], liveWork: work("waiting_on_you") }),
        issue(13, {
          projects: [{ id: "p", title: "Board", status: "In progress", priority: null }],
        }),
        issue(14, { pullRequests: [pr("closed")] }),
      ],
    );
    expect(first.map((section) => numbers(section.rows))).toEqual([
      [],
      [7, 11],
      [8, 12],
      [2, 3, 9, 13, 14],
      [1, 4, 5, 6, 10],
    ]);
    expect(
      issueLiveStatus(
        issue(1, { liveWork: [...work("idle"), ...work("waiting_on_you"), ...work("working")] }),
      ),
    ).toBe("working");
    const refreshed = issueRoadmap(
      scope,
      [],
      [
        issue(1, { liveWork: work("idle"), blockedBy: [ref(99, "closed")] }),
        issue(2, { liveWork: work("idle") }),
        issue(3),
        issue(4),
      ],
    );
    expect(refreshed.map((section) => numbers(section.rows))).toEqual([
      [],
      [],
      [],
      [1, 2, 3, 4],
      [],
    ]);
  });
});

it("puts queued issues first in insertion order and removes them from their other sections", () => {
  const sections = issueRoadmap(
    scope,
    [],
    [issue(1), issue(2, { blockedBy: [ref(99)] }), issue(3), issue(4, { state: "closed" })],
    [2, 1, 4],
  );
  expect(sections.map((section) => [section.title, numbers(section.rows)])).toEqual([
    ["Queued", [2, 1]],
    ["In progress", []],
    ["In review", []],
    ["Ready", [3]],
    ["Blocked", []],
  ]);
});
