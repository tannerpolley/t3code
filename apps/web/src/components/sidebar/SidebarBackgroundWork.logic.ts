import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type {
  OrchestrationV2PendingBackgroundTask,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

type ChildThread = SidebarThreadSummary;
type LinkedSubagentTask = Extract<OrchestrationV2PendingBackgroundTask, { kind: "subagent" }> & {
  readonly childThreadId: ThreadId;
};

type BackgroundWorkRowBase = {
  readonly taskId: string;
  readonly label: string;
  /** The current contract does not report task start times; linked child threads can. */
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
    });

/** A thread's stored model selection and effort, with no model fallback to its parent. */
export function resolveSidebarThreadModelLabel(
  thread: Pick<SidebarThreadSummary, "modelSelection">,
  provider: Pick<ServerProvider, "driver" | "models"> | undefined,
): string {
  const model = thread.modelSelection.model.trim();
  const modelSlug = provider
    ? resolveSelectableModel(provider.driver, model, provider.models)
    : model;
  const modelLabel = resolveSubagentMetadata({ model, provider }).modelLabel;
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
 * those roster entries pair with running children by count. Other pending task kinds stay visible
 * as display-only rows until the sidebar gains background process controls.
 */
export function describeSidebarBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  runningChildren: ReadonlyArray<ChildThread>,
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
    const linkedChildWork = linked.filter((task) => task.childThreadId === child.id);
    const hasPendingWork =
      backgroundWorkHoldsCompletion(child.pendingBackgroundTasks) ||
      backgroundWorkHoldsCompletion(linkedChildWork);
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
    startedAt: null,
    childThreadId: task.childThreadId ?? null,
  }));

  const backgroundTaskRows: BackgroundWorkTaskRow[] = tasks
    .filter((task) => task.kind !== "subagent")
    .map((task) => ({
      taskId: task.taskId,
      label: task.description ?? task.taskId,
      kind: task.kind,
      startedAt: null,
    }));

  return [...childRows, ...unmatchedSubagentRows, ...backgroundTaskRows];
}
