import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { afterTasksIndex, type BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
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

it("opens the summary row above the commands it folds, else before the agents", () => {
  const folded = { ...task("pytest"), underSummary: true };
  // Open: a pending task stays above the summary; the folded command goes below it.
  const open = withRunningCommandRows([task("dev-server"), agent], [folded]);
  expect(open[afterTasksIndex(open)]?.taskId).toBe("pytest");
  // Collapsed: no folded commands, so the summary sits right above the agents.
  const collapsed = withRunningCommandRows([task("dev-server"), agent], []);
  expect(collapsed[afterTasksIndex(collapsed)]?.taskId).toBe("agent");
  expect(afterTasksIndex([task("dev-server")])).toBe(-1);
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
