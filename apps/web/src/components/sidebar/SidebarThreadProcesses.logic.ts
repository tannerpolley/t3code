import type { ThreadProcessGroup } from "@t3tools/contracts";
import { shellProgramName } from "@t3tools/shared/shellCommand";

import type { BackgroundWorkTaskRow } from "./SidebarBackgroundWork.logic";

type BackgroundTaskRow = Exclude<BackgroundWorkTaskRow, { readonly kind: "subagent" }>;

/**
 * A thread's work rows: its own tasks and the running commands they don't already list, one row
 * per program, then its agents. All but the agents fold into the thread's Processes row, so
 * collapsed only agents show.
 */
export function foldThreadWork(
  rows: ReadonlyArray<BackgroundWorkTaskRow>,
  commandRows: ReadonlyArray<BackgroundWorkTaskRow>,
  open: boolean,
) {
  // A Codex background command is both a pending task and a running command item.
  const added = commandRows.filter((row) => !rows.some((listed) => listed.taskId === row.taskId));
  // The first row of a program stands for it; later ones only raise its count.
  const byProgram = new Map<string, BackgroundTaskRow>();
  for (const row of [...rows, ...added]) {
    if (row.kind === "subagent") continue;
    const key = workRowProgram(row) ?? `${row.kind}:${row.commandKind ?? ""}`;
    const first = byProgram.get(key);
    byProgram.set(key, first ? { ...first, sameProgram: (first.sameProgram ?? 1) + 1 } : row);
  }
  const work = [...byProgram.values()];
  const agents = rows.filter((row) => row.kind === "subagent");
  return { work, agents, rows: open ? [...work, ...agents] : agents };
}

/** A command or task row's program, which is its whole name in the sidebar; null without a command. */
export function workRowProgram(row: BackgroundWorkTaskRow): string | null {
  return row.kind === "subagent" || !row.command ? null : shellProgramName(row.command);
}

/** Most spawned process groups listed under one Processes row; the rest are counted. */
const VISIBLE_PROCESS_GROUPS = 5;

/**
 * The spawned process groups to list, largest first, and how many more there are. A program a
 * listed command already runs is that command's row, so its group is skipped before the cap.
 */
export function visibleProcessGroups(
  work: ReadonlyArray<BackgroundWorkTaskRow>,
  groups: ReadonlyArray<ThreadProcessGroup>,
) {
  const listed = new Set(work.map(workRowProgram));
  const unlisted = groups.filter((group) => !listed.has(group.label));
  return {
    groups: unlisted.slice(0, VISIBLE_PROCESS_GROUPS),
    hiddenCount: Math.max(0, unlisted.length - VISIBLE_PROCESS_GROUPS),
  };
}
