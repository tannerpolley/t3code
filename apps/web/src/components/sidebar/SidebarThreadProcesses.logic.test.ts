import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";
import { withRunningCommandRows } from "./SidebarThreadProcesses.logic";

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
