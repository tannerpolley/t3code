import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import { foldThreadWork, summarizeProcessWork } from "./SidebarThreadProcesses.logic";

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

it("folds tasks and each running command once under the summary, leaving agents listed", () => {
  // A Codex background command is both a pending task and a running command item.
  const rows = [task("dev-server"), agent];
  const commands = [task("dev-server"), task("pytest")];
  const open = foldThreadWork(rows, commands, true);
  expect(open.rows.map((row) => row.taskId)).toEqual(["dev-server", "pytest", "agent"]);
  const collapsed = foldThreadWork(rows, commands, false);
  expect(collapsed.rows.map((row) => row.taskId)).toEqual(["agent"]);
  expect(collapsed.total).toBe(3);
});

it("summarizes tasks, commands and process groups, and is empty with none", () => {
  const group = (count: number) => ({
    label: "python",
    commandLine: "python x.py",
    count,
    cpuPercent: 0,
    residentBytes: 0,
  });
  expect(summarizeProcessWork([], [], 0)).toBeNull();
  expect(summarizeProcessWork([task("watch", "monitor")], [], 0)).toBe("1 task");
  expect(summarizeProcessWork([task("a"), task("b"), task("c")], [group(4), group(1)], 2)).toBe(
    "3 commands · 5+ processes",
  );
});
