import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import { summarizeProcessWork, withRunningCommandRows } from "./SidebarThreadProcesses.logic";

const task = (taskId: string): BackgroundWorkTaskRow => ({
  taskId,
  label: taskId,
  kind: "command",
  startedAt: null,
});
const agent: BackgroundWorkTaskRow = {
  taskId: "agent",
  label: "agent",
  kind: "subagent",
  startedAt: null,
  childThreadId: ThreadId.make("child"),
};

it("lists each running command once, after the thread's tasks and before its agents", () => {
  // A Codex background command is both a pending task and a running command item.
  const rows = withRunningCommandRows(
    [task("dev-server"), agent],
    [task("dev-server"), task("pytest")],
  );
  expect(rows.map((row) => row.taskId)).toEqual(["dev-server", "pytest", "agent"]);
});

it("summarizes commands and process groups, and is empty with neither", () => {
  const group = (count: number, cpuPercent: number, residentBytes: number) => ({
    label: "python",
    commandLine: "python x.py",
    count,
    cpuPercent,
    residentBytes,
  });
  expect(summarizeProcessWork(0, [], 0)).toBeNull();
  expect(summarizeProcessWork(1, [], 0)?.text).toBe("1 command");
  // The server's total wins: it counts a command's own processes and groups past the cap.
  expect(summarizeProcessWork(1, [], 0, { cpuPercent: 40, residentBytes: 900 })).toMatchObject({
    cpuPercent: 40,
    residentBytes: 900,
  });
  expect(summarizeProcessWork(3, [group(4, 10, 100), group(1, 5, 50)], 2)).toEqual({
    text: "3 commands · 5+ processes",
    cpuPercent: 15,
    residentBytes: 150,
  });
});
