import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import { foldThreadWork, visibleProcessGroups } from "./SidebarThreadProcesses.logic";

const task = (taskId: string, kind: "command" | "monitor" = "command"): BackgroundWorkTaskRow => ({
  taskId,
  label: taskId,
  kind,
  startedAt: null,
});
const agent: BackgroundWorkTaskRow = {
  taskId: "agent",
  label: "agent",
  kind: "subagent",
  startedAt: null,
  childThreadId: ThreadId.make("child"),
};

it("folds commands under Processes one row per program, leaving agents listed", () => {
  const run = (taskId: string, command: string) => ({ ...task(taskId), command });
  // A Codex background command is both a pending task and a running command item.
  const rows = [run("dev", "npm run dev"), agent];
  const commands = [run("dev", "npm run dev"), run("build", "npm run build"), run("t", "pytest")];
  const open = foldThreadWork(rows, commands, true);
  expect(
    open.rows.map((row) => [row.taskId, row.kind === "subagent" ? 0 : row.sameProgram]),
  ).toEqual([
    ["dev", 2],
    ["t", undefined],
    ["agent", 0],
  ]);
  expect(foldThreadWork(rows, commands, false).rows.map((row) => row.taskId)).toEqual(["agent"]);
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
