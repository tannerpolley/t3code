import { RunId, ThreadId, type ThreadProcesses } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import {
  describeSidebarBackgroundWork,
  type BackgroundWorkTaskRow,
} from "./SidebarBackgroundWork.logic";
import {
  foldThreadWork,
  hasKnownSidebarWork,
  sidebarSubagentRowStatus,
  resolveSidebarProjectStatusMark,
  visibleProcessGroups,
  sidebarWorkExpanded,
  withRunningProcessWork,
} from "./SidebarThreadProcesses.logic";

const task = (taskId: string, kind: "command" | "monitor" = "command"): BackgroundWorkTaskRow => ({
  taskId,
  label: taskId,
  kind,
  startedAt: null,
});

it("marks sampled work as waiting only after the thread settles, independent of expansion", () => {
  const none: ThreadProcesses = {
    commands: [],
    runningTaskIds: [],
    processGroups: [],
    hiddenProcessGroupCount: 0,
  };
  const samples: ThreadProcesses[] = [
    { ...none, runningTaskIds: ["background-task"] },
    {
      ...none,
      commands: [
        {
          taskId: "command",
          command: "make",
          commandKind: "build",
          startedAt: null,
          followable: true,
        },
      ],
    },
    {
      ...none,
      processGroups: [
        {
          label: "python",
          commandLine: "python worker.py",
          count: 3,
          cpuPercent: 0,
          residentBytes: 0,
        },
      ],
    },
  ];
  for (const sample of samples) {
    expect(withRunningProcessWork("ready", sample)).toBe("waiting");
    for (const status of [
      "working",
      "waiting",
      "approval",
      "input",
      "failed",
      "limited",
    ] as const) {
      expect(withRunningProcessWork(status, sample)).toBe(status);
    }
  }
  expect(withRunningProcessWork("ready", none)).toBe("ready");
  expect(withRunningProcessWork("ready", undefined)).toBe("ready");
  expect(withRunningProcessWork("ready", null)).toBe("ready");
  expect(withRunningProcessWork("waiting", undefined)).toBe("waiting");
});

it("polls only known work, including leftover commands and inherited child tasks", () => {
  const idle = { pendingBackgroundTasks: [] };
  expect(hasKnownSidebarWork(idle, "ready", [])).toBe(false);
  expect(hasKnownSidebarWork(idle, "waiting", [])).toBe(false);
  expect(hasKnownSidebarWork(idle, "failed", [])).toBe(false);
  expect(hasKnownSidebarWork(idle, "working", [])).toBe(true);
  expect(
    hasKnownSidebarWork(
      { pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] },
      "ready",
      [],
    ),
  ).toBe(true);
  expect(hasKnownSidebarWork(idle, "ready", [task("inherited")])).toBe(true);
});

it("overlays known background work in Projects after unseen completion has been seen", () => {
  const fixture = makeThreadFixture();
  const thread = presentThreadShell(fixture.environmentId, {
    ...fixture.source,
    latestRunId: RunId.make("completed"),
    status: "completed",
    latestRunCompletedAt: DateTime.makeUnsafe("2026-10-20T10:00:00.000Z"),
    lastVisitedAt: DateTime.makeUnsafe("2026-10-20T09:00:00.000Z"),
    pendingBackgroundTasks: [{ taskId: "dev", kind: "command", command: "npm run dev" }],
  });
  const status = resolveSidebarThreadStatus(thread);
  expect(status).toBe("ready");
  const rows = describeSidebarBackgroundWork(thread.pendingBackgroundTasks, []);
  const workStatus = withRunningProcessWork(
    status,
    undefined,
    hasKnownSidebarWork(thread, status, rows),
  );
  expect(workStatus).toBe("waiting");
  expect(resolveSidebarProjectStatusMark(thread, undefined, status, workStatus)).toBe("done");
  expect(
    resolveSidebarProjectStatusMark(
      { ...thread, lastVisitedAt: "2026-10-20T10:01:00.000Z" },
      undefined,
      status,
      workStatus,
    ),
  ).toBe("waiting");
  for (const urgent of ["working", "approval", "input", "failed", "limited"] as const) {
    expect(withRunningProcessWork(urgent, undefined, true)).toBe(urgent);
  }
});

it("keeps the assembled child row waiting on the parent's roster with no sampled work", () => {
  const child = makeThreadFixture({ runtime: null, latestRun: null, pendingBackgroundTasks: [] });
  const [row] = describeSidebarBackgroundWork(
    [{ taskId: "linked", kind: "subagent", childThreadId: child.id }],
    [child],
  );
  expect(resolveSidebarThreadStatus(child)).toBe("ready");
  const status = sidebarSubagentRowStatus(row!, []);
  expect(withRunningProcessWork(status, undefined)).toBe("waiting");
  expect(
    withRunningProcessWork(status, {
      commands: [],
      runningTaskIds: [],
      processGroups: [],
      hiddenProcessGroupCount: 0,
    }),
  ).toBe("waiting");
});

const agent: BackgroundWorkTaskRow = {
  taskId: "agent",
  label: "agent",
  kind: "subagent",
  startedAt: null,
  childThreadId: ThreadId.make("child"),
};

it("lists commands directly before agents, deduplicating each program", () => {
  const run = (taskId: string, command: string) => ({ ...task(taskId), command });
  // A Codex background command is both a pending task and a running command item.
  const rows = [run("dev", "npm run dev"), agent];
  const commands = [run("dev", "npm run dev"), run("build", "npm run build"), run("t", "pytest")];
  const open = foldThreadWork(rows, commands);
  expect(
    open.rows.map((row) => [row.taskId, row.kind === "subagent" ? 0 : row.sameProgram]),
  ).toEqual([
    ["dev", 2],
    ["t", undefined],
    ["agent", 0],
  ]);
});

it("lists each program once, skipping a command's program before capping the groups", () => {
  const group = (label: string) => ({
    label,
    commandLine: label,
    count: 1,
    cpuPercent: 0,
    residentBytes: 0,
  });
  const work = [{ ...task("dev"), command: "cd web && npm run dev" }];
  const groups = ["npm", "a", "b", "c", "d", "e", "f"].map(group);
  const visible = visibleProcessGroups(work, groups);
  expect(visible.groups.map((g) => g.label)).toEqual(["a", "b", "c", "d", "e"]);
  expect(visible.hiddenCount).toBe(1);
});

it("opens work only for running agents unless the user toggled the row", () => {
  expect(sidebarWorkExpanded(undefined, false)).toBe(false);
  expect(sidebarWorkExpanded(undefined, true)).toBe(true);
  expect(sidebarWorkExpanded(true, false)).toBe(true);
  expect(sidebarWorkExpanded(false, true)).toBe(false);
});
