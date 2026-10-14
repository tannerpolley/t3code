import type { ThreadProcessGroup } from "@t3tools/contracts";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";

/** Adds running commands the list does not already show, after its tasks and before its agents. */
export function withRunningCommandRows(
  rows: ReadonlyArray<BackgroundWorkTaskRow>,
  commandRows: ReadonlyArray<BackgroundWorkTaskRow>,
): ReadonlyArray<BackgroundWorkTaskRow> {
  const added = commandRows.filter((row) => !rows.some((listed) => listed.taskId === row.taskId));
  if (added.length === 0) return rows;
  const firstAgent = rows.findIndex((row) => row.kind === "subagent");
  const at = firstAgent === -1 ? rows.length : firstAgent;
  return [...rows.slice(0, at), ...added, ...rows.slice(at)];
}

/**
 * The collapsed row for a thread's running commands and spawned processes: how many of each, and
 * their combined usage. Null when there is nothing to show. Processes count the listed groups
 * only, so `moreProcesses` marks a total that hidden groups would raise.
 */
export function summarizeProcessWork(
  commandCount: number,
  groups: ReadonlyArray<ThreadProcessGroup>,
  hiddenGroupCount: number,
  usage?: { readonly cpuPercent: number; readonly residentBytes: number },
) {
  const processes = groups.reduce((total, group) => total + group.count, 0);
  if (commandCount === 0 && processes === 0) return null;
  const parts = [
    commandCount > 0 ? `${commandCount} ${commandCount === 1 ? "command" : "commands"}` : null,
    processes > 0
      ? `${processes}${hiddenGroupCount > 0 ? "+" : ""} ${processes === 1 ? "process" : "processes"}`
      : null,
  ];
  return {
    text: parts.filter((part) => part !== null).join(" · "),
    // The server's total also counts the commands' own processes and the groups past the cap.
    cpuPercent: usage?.cpuPercent ?? groups.reduce((total, group) => total + group.cpuPercent, 0),
    residentBytes:
      usage?.residentBytes ?? groups.reduce((total, group) => total + group.residentBytes, 0),
  };
}
