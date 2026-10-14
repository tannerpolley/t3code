import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { fileBasename } from "@t3tools/shared/path";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import {
  isProviderNativeSubagentThread,
  THREAD_ROLE_LABELS,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import {
  backgroundWorkHoldsCompletion,
  pendingBackgroundWorkOfThread,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { shortModelName } from "../chat/providerIconUtils";

type ChildThread = SidebarThreadSummary;
type LinkedSubagentTask = Extract<OrchestrationV2PendingBackgroundTask, { kind: "subagent" }> & {
  readonly childThreadId: ThreadId;
};

type BackgroundWorkRowBase = {
  readonly taskId: string;
  readonly label: string;
  /** Task start, or the linked child thread's current work start. */
  readonly startedAt: string | null;
  readonly status?: SidebarThreadStatus | undefined;
};

export type BackgroundWorkTaskRow =
  | (BackgroundWorkRowBase & {
      readonly kind: "subagent";
      /** The subagent's thread when it is known. */
      readonly childThreadId: ThreadId | null;
      readonly child?: ChildThread | undefined;
    })
  | (BackgroundWorkRowBase & {
      readonly kind: "command" | "monitor" | "background_task";
      readonly commandKind?: string;
      readonly ownerThreadId?: ThreadId;
    });

/**
 * The name of the worktree a child thread works in (its folder), for its worktree icon's tooltip;
 * null when it shares its parent's checkout. A null `worktreePath` is the project root, and an unknown
 * parent counts as the root.
 */
export function childWorktreeLabel(
  child: Pick<SidebarThreadSummary, "worktreePath">,
  parent: Pick<SidebarThreadSummary, "worktreePath"> | null | undefined,
): string | null {
  if (child.worktreePath == null || child.worktreePath === (parent?.worktreePath ?? null)) {
    return null;
  }
  return fileBasename(child.worktreePath);
}

/**
 * Whether a child works in its parent's checkout or worktree, so only the parent's row needs the
 * location mark. A child whose worktree is still being prepared has no path yet but is elsewhere.
 */
export function sharesParentLocation(
  child: Pick<SidebarThreadSummary, "worktreePath" | "branch"> & {
    readonly source: Pick<SidebarThreadSummary["source"], "status">;
  },
  parent: Pick<SidebarThreadSummary, "worktreePath"> | null | undefined,
): boolean {
  if (!parent || child.worktreePath !== parent.worktreePath) return false;
  return !(child.worktreePath === null && child.source.status === "preparing" && child.branch);
}

/**
 * A thread's stored model selection and effort, with no model fallback to its parent. `short`
 * is the shortModelNames switch.
 */
export function resolveSidebarThreadModelLabel(
  thread: Pick<SidebarThreadSummary, "modelSelection">,
  provider: Pick<ServerProvider, "driver" | "models"> | undefined,
  short = false,
  includeEffort = true,
): string {
  const model = thread.modelSelection.model.trim();
  const modelSlug = provider
    ? resolveSelectableModel(provider.driver, model, provider.models)
    : model;
  const fullLabel = resolveSubagentMetadata({ model, provider }).modelLabel;
  const modelLabel = short ? shortModelName(fullLabel) : fullLabel;
  const effort = formatModelSelectionEffort(
    { ...thread.modelSelection, model: modelSlug ?? model },
    provider?.models,
  );
  return !includeEffort || effort === null ? modelLabel : `${modelLabel} · ${effort}`;
}

/**
 * What a thread row is titled instead of its task name: an issue worker's issue, else the thread's
 * role, else Main for a top-level thread or Subagent for a child. The name shows on hover.
 */
export function sidebarThreadTitle(
  thread: Pick<OrchestrationV2ThreadShell, "role" | "linkedIssue"> & {
    readonly lineage: Pick<OrchestrationV2ThreadShell["lineage"], "relationshipToParent">;
  },
): string {
  if (thread.linkedIssue) return `#${thread.linkedIssue.number} ${thread.linkedIssue.title}`;
  if (thread.role) return THREAD_ROLE_LABELS[thread.role];
  return thread.lineage.relationshipToParent === "subagent" ? "Subagent" : "Main";
}

/**
 * A short model label split for the sidebar's aligned model columns: the name, cut to six
 * characters, and the version number ("Opus 5.5" → Opus, 5.5; "GPT-5.4" → GPT, 5.4). Text after
 * the version, such as "Codex" or "(High)", shows only on hover; a label without a version keeps
 * its name alone.
 */
export function splitSidebarModelLabel(label: string): {
  readonly name: string;
  readonly version: string;
} {
  const match = /^(.*?)[\s-]+(\d+(?:\.\d+)*)/.exec(label);
  return { name: (match ? match[1]! : label).trim().slice(0, 6), version: match?.[2] ?? "" };
}

/** Separates subagent threads from other pending work without changing either group's order. */
export function groupBackgroundWorkTaskRows(rows: ReadonlyArray<BackgroundWorkTaskRow>) {
  return {
    agents: rows.filter((row) => row.kind === "subagent"),
    backgroundTasks: rows.filter((row) => row.kind !== "subagent"),
  };
}

/**
 * Joins provider-reported subagent tasks to their thread rows. Some providers omit a child id;
 * those roster entries pair with running children by count. Commands started by a child sit
 * beneath that child while staying on the parent provider's roster.
 *
 * Under a thread the order is: its own background tasks, its native subagents (roster-only ones
 * included), then its app-owned children.
 */
export function describeSidebarBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  runningChildren: ReadonlyArray<ChildThread>,
  ownerThreadId?: ThreadId,
): ReadonlyArray<BackgroundWorkTaskRow> {
  const listedChildIds = new Set(runningChildren.map((child) => child.id));
  const linked = tasks.filter(
    (task): task is LinkedSubagentTask =>
      task.kind === "subagent" && task.childThreadId !== undefined,
  );
  const unlinked = tasks.filter(
    (task): task is Extract<OrchestrationV2PendingBackgroundTask, { kind: "subagent" }> =>
      task.kind === "subagent" && task.childThreadId === undefined,
  );
  // ponytail: roster-only tasks have no child id, so the fallback can only pair by count; it
  // cannot prove which running child owns each task.
  const unlinkedChildren = runningChildren.filter(
    (child) => !linked.some((task) => task.childThreadId === child.id),
  ).length;

  const childRows: BackgroundWorkTaskRow[] = runningChildren.map((child) => {
    const currentStatus = resolveSidebarThreadStatus(child);
    const hasPendingWork =
      backgroundWorkHoldsCompletion(
        pendingBackgroundWorkOfThread(child.id, child.pendingBackgroundTasks, tasks),
      ) || backgroundWorkHoldsCompletion(linked.filter((task) => task.childThreadId === child.id));
    const status = currentStatus === "ready" && hasPendingWork ? "waiting" : currentStatus;

    return {
      taskId: child.id,
      label: child.title,
      kind: "subagent",
      startedAt: resolveThreadWorkingStartedAt({ ...child, waiting: status === "waiting" }),
      childThreadId: child.id,
      status,
      child,
    };
  });

  const unmatchedSubagentRows: BackgroundWorkTaskRow[] = [
    ...linked.filter((task) => !listedChildIds.has(task.childThreadId)),
    ...unlinked.slice(unlinkedChildren),
  ].map((task) => ({
    taskId: task.taskId,
    label: task.description ?? task.taskId,
    kind: "subagent",
    startedAt: task.startedAt ? DateTime.formatIso(task.startedAt) : null,
    childThreadId: task.childThreadId ?? null,
  }));

  const backgroundTaskRows: BackgroundWorkTaskRow[] = tasks
    .filter((task) => task.kind !== "subagent")
    .filter((task) => {
      const owner = task.ownerThreadId ?? task.childThreadId;
      return owner === undefined || !listedChildIds.has(owner);
    })
    .map((task) => {
      const taskOwner = task.ownerThreadId ?? task.childThreadId ?? ownerThreadId;
      return {
        taskId: task.taskId,
        label: task.description ?? task.taskId,
        kind: task.kind,
        startedAt: task.startedAt ? DateTime.formatIso(task.startedAt) : null,
        ...(task.commandKind === undefined ? {} : { commandKind: task.commandKind }),
        ...(taskOwner === undefined ? {} : { ownerThreadId: taskOwner }),
      };
    });

  // Native children come first (see groupRunningSubagentsByParent). Roster-only subagents are the
  // provider's own, so they join the natives, ahead of app-owned children.
  const firstAppOwned = runningChildren.findIndex(
    (child) => !isProviderNativeSubagentThread(child.source),
  );
  const split = firstAppOwned === -1 ? childRows.length : firstAppOwned;
  return [
    ...backgroundTaskRows,
    ...childRows.slice(0, split),
    ...unmatchedSubagentRows,
    ...childRows.slice(split),
  ];
}

/** Warn after two hours, while long-lived servers keep their normal age display. */
export const POSSIBLY_STUCK_SHELL_MS = 2 * 60 * 60 * 1000;
export function msUntilPossiblyStuck(startedAt: string, nowMs: number): number {
  return Math.max(0, Date.parse(startedAt) + POSSIBLY_STUCK_SHELL_MS - nowMs);
}

/** Only descendants of this row can invalidate its work tree. */
export function sameSidebarSubagentTree(
  parentKey: string,
  previous: ReadonlyMap<string, readonly SidebarThreadSummary[]>,
  next: ReadonlyMap<string, readonly SidebarThreadSummary[]>,
): boolean {
  const pending = [parentKey];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const before = previous.get(key) ?? [];
    const after = next.get(key) ?? [];
    if (before.length !== after.length) return false;
    for (let index = 0; index < before.length; index++) {
      const child = before[index]!;
      if (child !== after[index]) return false;
      pending.push(scopedThreadKey(scopeThreadRef(child.environmentId, child.id)));
    }
  }
  return true;
}
