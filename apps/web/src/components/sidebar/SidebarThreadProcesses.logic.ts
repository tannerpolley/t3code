import type { ThreadProcessGroup } from "@t3tools/contracts";
import { shellProgramName } from "@t3tools/shared/shellCommand";

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

/** A command or task row's program, which is its whole name in the sidebar; null without a command. */
export function workRowProgram(row: BackgroundWorkTaskRow): string | null {
  return row.kind === "subagent" || !row.command ? null : shellProgramName(row.command);
}

/** Spawned process groups whose program no listed command already names, so each program shows once. */
export function unlistedProcessGroups(
  work: ReadonlyArray<BackgroundWorkTaskRow>,
  groups: ReadonlyArray<ThreadProcessGroup>,
): ReadonlyArray<ThreadProcessGroup> {
  const listed = new Set(work.map(workRowProgram));
  return groups.filter((group) => !listed.has(group.label));
}
