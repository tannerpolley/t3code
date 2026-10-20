import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { SidebarThreadSummary } from "../../types";
import {
  describeSidebarBackgroundWork,
  type BackgroundWorkTaskRow,
} from "./SidebarBackgroundWork.logic";
import { sidebarWorkExpanded } from "./SidebarThreadProcesses.logic";

export type SidebarFamilySeparator = "solid" | "dashed";
type DisplayedFamilyRow = {
  readonly key: string;
  readonly familyKey: string;
  readonly workspace: string | null;
};

export function sidebarSubagentRowKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  row: BackgroundWorkTaskRow,
) {
  return row.kind === "subagent" && row.childThreadId !== null
    ? scopedThreadKey(scopeThreadRef(environmentId, row.childThreadId))
    : `${scopedThreadKey(scopeThreadRef(environmentId, threadId))}:task:${row.taskId}`;
}

export function collectDisplayedFamilyRows(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly runningSubagentsByParentKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly expandedByKey: Readonly<Record<string, boolean>>;
}): DisplayedFamilyRow[] {
  const displayed: DisplayedFamilyRow[] = [];
  const visit = (thread: SidebarThreadSummary, parent?: SidebarThreadSummary) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const familyKey = scopedThreadKey(
      scopeThreadRef(thread.environmentId, thread.lineage.rootThreadId),
    );
    displayed.push({
      key,
      familyKey,
      workspace: thread.worktreePath,
    });
    const rows = describeSidebarBackgroundWork(
      parent === undefined
        ? thread.pendingBackgroundTasks
        : pendingBackgroundWorkOfThread(
            thread.id,
            thread.pendingBackgroundTasks,
            parent.pendingBackgroundTasks,
          ),
      input.runningSubagentsByParentKey.get(key) ?? [],
      parent === undefined ? undefined : thread.id,
    );
    if (
      !sidebarWorkExpanded(
        input.expandedByKey[key],
        rows.some((row) => row.kind === "subagent"),
      )
    )
      return;
    for (const row of rows) {
      if (row.kind !== "subagent") continue;
      if (row.child) visit(row.child, thread);
      else
        displayed.push({
          key: sidebarSubagentRowKey(thread.environmentId, thread.id, row),
          familyKey,
          workspace: thread.worktreePath,
        });
    }
  };
  input.threads.forEach((thread) => visit(thread));
  return displayed;
}

/** One marker per boundary, using only rows that are actually displayed in this project. */
export function resolveSidebarFamilySeparators(rows: readonly DisplayedFamilyRow[]) {
  const familySizes = new Map<string, number>();
  for (const row of rows) familySizes.set(row.familyKey, (familySizes.get(row.familyKey) ?? 0) + 1);
  const separators = new Map<string, SidebarFamilySeparator>();
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!;
    const row = rows[index]!;
    if (previous.familyKey !== row.familyKey) {
      if (familySizes.get(previous.familyKey)! > 1 || familySizes.get(row.familyKey)! > 1)
        separators.set(row.key, "solid");
    } else if (previous.workspace !== row.workspace) {
      separators.set(row.key, "dashed");
    }
  }
  return separators;
}
