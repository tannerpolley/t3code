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
