import type { ThreadProcessGroup } from "@t3tools/contracts";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";

/**
 * A thread's work rows: its own tasks, the running commands they don't already list, then its
 * agents. All but the agents fold into the thread's summary row, so collapsed only agents show.
 */
export function foldThreadWork(
  rows: ReadonlyArray<BackgroundWorkTaskRow>,
  commandRows: ReadonlyArray<BackgroundWorkTaskRow>,
  open: boolean,
) {
  // A Codex background command is both a pending task and a running command item.
  const added = commandRows.filter((row) => !rows.some((listed) => listed.taskId === row.taskId));
  const work = [...rows.filter((row) => row.kind !== "subagent"), ...added];
  const agents = rows.filter((row) => row.kind === "subagent");
  return { work, rows: open ? [...work, ...agents] : agents, total: work.length + agents.length };
}

/**
 * The summary row's text: how many tasks, commands and spawned processes it folds. Null when there
 * is nothing to show. Processes count the listed groups only, so "+" marks a total that hidden
 * groups would raise.
 */
export function summarizeProcessWork(
  work: ReadonlyArray<BackgroundWorkTaskRow>,
  groups: ReadonlyArray<ThreadProcessGroup>,
  hiddenGroupCount: number,
): string | null {
  const commands = work.filter((row) => row.kind === "command").length;
  const tasks = work.length - commands;
  const processes = groups.reduce((total, group) => total + group.count, 0);
  const parts = [
    tasks > 0 ? `${tasks} ${tasks === 1 ? "task" : "tasks"}` : null,
    commands > 0 ? `${commands} ${commands === 1 ? "command" : "commands"}` : null,
    processes > 0
      ? `${processes}${hiddenGroupCount > 0 ? "+" : ""} ${processes === 1 ? "process" : "processes"}`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
