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
