import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import {
  foldThreadWork,
  unlistedProcessGroups,
  workRowProgram,
} from "./SidebarThreadProcesses.logic";

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

it("lists each program once: a spawned group a command already names is dropped", () => {
  const group = (label: string) => ({
    label,
    commandLine: label,
    count: 2,
    cpuPercent: 0,
    residentBytes: 0,
  });
  const work = [{ ...task("dev"), command: "cd web && npm run dev -- --port 5173" }, task("watch")];
  expect(workRowProgram(work[0]!)).toBe("npm");
  expect(workRowProgram(task("watch"))).toBeNull();
  expect(unlistedProcessGroups(work, [group("npm"), group("node")]).map((g) => g.label)).toEqual([
    "node",
  ]);
});
