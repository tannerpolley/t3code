import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import {
  sidebarProjectThreadCheckout,
  sidebarProjectThreadAccessibleName,
  sidebarProjectThreadPullRequests,
} from "./SidebarProjectThread.logic";

describe("Projects thread checkout hover", () => {
  it("identifies the project checkout with its full path", () => {
    expect(
      sidebarProjectThreadCheckout({
        worktreePath: null,
        projectPath: "/work/project",
        preparingWorktree: false,
      }),
    ).toEqual({ label: "Project checkout", path: "/work/project" });
  });

  it.each([
    [" /work/project/.worktrees/feature ", "feature", "/work/project/.worktrees/feature"],
    ["C:\\work\\feature\\", "feature", "C:\\work\\feature\\"],
  ])("names the folder while retaining the full worktree path: %s", (path, folder, fullPath) => {
    expect(
      sidebarProjectThreadCheckout({
        worktreePath: path,
        projectPath: "/work/project",
        preparingWorktree: true,
      }),
    ).toEqual({ label: `Worktree ${folder}`, path: fullPath });
  });

  it("does not claim a preparing child's checkout is the project root", () => {
    expect(
      sidebarProjectThreadCheckout({
        worktreePath: null,
        projectPath: "/work/project",
        preparingWorktree: true,
      }),
    ).toEqual({ label: "Preparing worktree", path: null });
    expect(
      sidebarProjectThreadCheckout({
        worktreePath: " ",
        projectPath: undefined,
        preparingWorktree: false,
      }),
    ).toEqual({ label: "Project checkout", path: null });
  });
});

function link(
  number: number,
  state: ThreadPullRequestSnapshot["state"] = "open",
  isDraft = false,
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    source: "manual",
    linkedAt: "2026-10-15T12:00:00.000Z",
    stack: null,
    snapshot: {
      state,
      isDraft,
      title: `Change ${number}`,
      headBranch: `feature-${number}`,
      baseBranch: "main",
      updatedAt: null,
      syncedAt: "2026-10-15T12:00:00.000Z",
    },
  };
}

describe("Projects persisted PR glyph", () => {
  it.each([
    ["open", false, "open"],
    ["open", true, "draft"],
    ["merged", true, "merged"],
    ["closed", true, "closed"],
  ] as const)(
    "uses the upstream state glyph and colors for %s (draft: %s)",
    (state, draft, expected) => {
      const presentation = PULL_REQUEST_STATE_PRESENTATION[expected];
      expect(sidebarProjectThreadPullRequests([link(1, state, draft)])).toEqual({
        ...presentation,
        count: 1,
        label: `1 pull request, ${presentation.label.toLowerCase()} (last recorded)`,
      });
    },
  );

  it("omits absent snapshots and dismissed links rather than inventing open state", () => {
    const unsynced = { ...link(1), snapshot: null };
    const dismissed = { ...link(2), source: "stack-dismissed" as const };
    expect(sidebarProjectThreadPullRequests([])).toBeNull();
    expect(sidebarProjectThreadPullRequests([unsynced, dismissed])).toBeNull();
    expect(
      sidebarProjectThreadPullRequests([unsynced, dismissed, link(3, "merged")]),
    ).toMatchObject({
      ...PULL_REQUEST_STATE_PRESENTATION.merged,
      label: expect.stringContaining("merged"),
      count: 1,
    });
  });

  it("counts snapshots and folds multiple PR states using upstream's rules", () => {
    expect(sidebarProjectThreadPullRequests([link(1, "merged"), link(2, "merged")])).toMatchObject({
      ...PULL_REQUEST_STATE_PRESENTATION.merged,
      label: expect.stringContaining("merged"),
      count: 2,
    });
    expect(sidebarProjectThreadPullRequests([link(1, "merged"), link(2, "closed")])).toMatchObject({
      ...PULL_REQUEST_STATE_PRESENTATION.closed,
      label: expect.stringContaining("closed"),
      count: 2,
    });
    expect(sidebarProjectThreadPullRequests([link(1, "closed"), link(2)])).toMatchObject({
      ...PULL_REQUEST_STATE_PRESENTATION.open,
      label: expect.stringContaining("open"),
      count: 2,
    });
    expect(
      sidebarProjectThreadPullRequests([link(1, "open", true), link(2, "open", true)]),
    ).toMatchObject({
      ...PULL_REQUEST_STATE_PRESENTATION.draft,
      label: expect.stringContaining("draft"),
      count: 2,
    });
  });
});

describe("Projects thread row name", () => {
  it("announces the recorded PR state with the title and status", () => {
    expect(sidebarProjectThreadAccessibleName("Fix solver", "ready", [link(7, "merged")])).toBe(
      "Fix solver, ready, 1 pull request, merged (last recorded)",
    );
    expect(sidebarProjectThreadAccessibleName("Fix solver", "ready", [])).toBe("Fix solver, ready");
  });
});
