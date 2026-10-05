import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type {
  OrchestrationV2PendingBackgroundTask,
  ServerProvider,
  ThreadId,
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
 * A thread's stored model selection and effort, with no model fallback to its parent. `short`
 * is the shortModelNames switch.
 */
export function resolveSidebarThreadModelLabel(
  thread: Pick<SidebarThreadSummary, "modelSelection">,
  provider: Pick<ServerProvider, "driver" | "models"> | undefined,
  short = false,
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
  return effort === null ? modelLabel : `${modelLabel} · ${effort}`;
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
      startedAt: resolveThreadWorkingStartedAt(child),
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

  return [...childRows, ...unmatchedSubagentRows, ...backgroundTaskRows];
}

/** Warn after two hours, while long-lived servers keep their normal age display. */
export const POSSIBLY_STUCK_SHELL_MS = 2 * 60 * 60 * 1000;
export function msUntilPossiblyStuck(startedAt: string, nowMs: number): number {
  return Math.max(0, Date.parse(startedAt) + POSSIBLY_STUCK_SHELL_MS - nowMs);
}
