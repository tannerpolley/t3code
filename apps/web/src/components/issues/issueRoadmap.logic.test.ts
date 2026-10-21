import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId, type IssueMilestone, type IssueSummary } from "@t3tools/contracts";
import { issueRoadmap, issueLiveStatus, createIssueRoadmapClock } from "./issueRoadmap.logic";

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
const inSection = (sections: ReturnType<typeof issueRoadmap>, id: string) =>
  sections.find((section) => section.id === id)!;

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
    expect(numbers(inSection(sections, "ready").rows)).toEqual([423, 431]);
    expect(numbers(inSection(sections, "blocked").rows)).toEqual([432, 434, 439, 435]);
    const blocked = numbers(inSection(sections, "blocked").rows);
    expect(blocked.indexOf(439)).toBeLessThan(blocked.indexOf(435));
  });
  it("orders an open child before its parent, ignores closed children and closed blockers, and separates closed issues", () => {
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
    expect(numbers(inSection(sections, "ready").rows)).toEqual([2, 7, 1]);
    expect(inSection(sections, "blocked").rows).toEqual([]);
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
    expect(numbers(inSection(sections, "ready").rows)).toEqual([7, 8, 9, 3, 2, 1]);
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
    expect(numbers(inSection(sections, "in-progress").rows)).toEqual([3, 2]);
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
    expect(numbers(inSection(sections, "blocked").rows)).toEqual([1, 2, 7]);
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
    expect(numbers(inSection(sections, "ready").rows)).toEqual([1, 9]);
    expect(
      sections
        .flatMap((section) => section.rows)
        .filter((row) => row.cycle)
        .map((row) => row.issue.number)
        .sort((a, b) => a - b),
    ).toEqual([3, 4, 9]);
    expect(numbers(inSection(sections, "blocked").rows)).toEqual([3, 4, 2]);
    expect(inSection(sections, "blocked").rows.find((row) => row.issue.number === 2)?.cycle).toBe(
      false,
    );
  });
  it("keeps only running agents In progress, open PRs In progress, and blockers ahead of both", () => {
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
      [1, 4, 5, 6, 10],
      [2, 3, 9, 13, 14],
      [],
      [7, 8, 11, 12],
      [],
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
      [1, 2, 3, 4],
      [],
      [],
      [],
    ]);
  });
});

it("puts queued issues after Ready in insertion order and removes them from their other sections", () => {
  const sections = issueRoadmap(
    scope,
    [],
    [issue(1), issue(2, { blockedBy: [ref(99)] }), issue(3), issue(4, { state: "closed" })],
    [2, 1, 4],
  );
  expect(sections.map((section) => [section.title, numbers(section.rows)])).toEqual([
    ["Closed", [4]],
    ["Blocked", []],
    ["Ready", [3]],
    ["Queued", [2, 1]],
    ["In progress", []],
    ["Done", []],
  ]);
});

it("moves completed and not-planned issues from Done to Closed at exactly 24 hours, using closure time", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const issues = [
    issue(1, { state: "closed", stateReason: "completed", closedAt: "2026-10-19T12:00:00.001Z" }),
    issue(2, { state: "closed", stateReason: "not_planned", closedAt: "2026-10-20T11:00:00Z" }),
    issue(3, {
      state: "closed",
      closedAt: "2026-10-19T12:00:00Z",
      updatedAt: "2026-10-20T11:59:00Z",
    }),
    issue(4, { state: "closed", closedAt: null }),
    issue(5, { closedAt: "2026-10-20T11:00:00Z" }),
  ];
  const groups = (at: number) =>
    Object.fromEntries(
      issueRoadmap(scope, [], issues, [], at).map((section) => [section.id, numbers(section.rows)]),
    );
  expect(groups(now)).toMatchObject({ ready: [5], done: [2, 1], closed: [3, 4] });
  expect(groups(now + 1)).toMatchObject({ done: [2], closed: [1, 3, 4] });
});

it("notifies at closure expiry without polling and cancels its timer when the view leaves", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T11:59:59.999Z"));
  try {
    const closed = issue(1, { state: "closed", closedAt: "2026-10-19T12:00:00Z" });
    const clock = createIssueRoadmapClock([closed]);
    const changes = vi.fn();
    const unsubscribe = clock.subscribe(changes);
    expect(
      issueRoadmap(scope, [], [closed], [], clock.snapshot()).find((group) => group.id === "done")
        ?.rows,
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(changes).toHaveBeenCalledOnce();
    expect(
      issueRoadmap(scope, [], [closed], [], clock.snapshot()).find((group) => group.id === "closed")
        ?.rows,
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
    vi.setSystemTime(new Date("2026-10-20T11:00:00Z"));
    const stop = createIssueRoadmapClock([closed]).subscribe(changes);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("holds unacknowledged openings out of every open section, then restores their normal state", () => {
  const issues = [
    issue(1),
    issue(2, { blockedBy: [ref(1)] }),
    issue(3, { liveWork: work("working") }),
    issue(4),
  ];
  const before = issueRoadmap(scope, [], issues, [], Date.now(), [1, 2, 3]);
  expect(before.flatMap((section) => numbers(section.rows))).toEqual([4]);
  const acknowledged = issueRoadmap(scope, [], issues, [], Date.now(), []);
  expect(numbers(inSection(acknowledged, "ready").rows)).toEqual([1, 4]);
  expect(numbers(inSection(acknowledged, "blocked").rows)).toEqual([2]);
  expect(numbers(inSection(acknowledged, "in-progress").rows)).toEqual([3]);
});
