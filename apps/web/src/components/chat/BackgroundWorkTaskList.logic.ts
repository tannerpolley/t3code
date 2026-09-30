import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import {
  heldBackgroundWork,
  isAgentBackgroundTask as isAgentTask,
  pendingBackgroundWorkOfThread,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

/** A background shell running longer than this may be a wait loop that never ends. */
export const POSSIBLY_STUCK_SHELL_MS = 2 * 60 * 60 * 1000;

/** Milliseconds until a shell started at `startedAt` (ISO) counts as possibly stuck; 0 once it does. */
export function msUntilPossiblyStuck(startedAt: string, nowMs: number): number {
  return Math.max(0, Date.parse(startedAt) + POSSIBLY_STUCK_SHELL_MS - nowMs);
}

const isoOrNull = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.formatIso(value) : null;

export interface BackgroundWorkTaskRow {
  readonly taskId: string;
  readonly label: string;
  readonly kind: "subagent" | "process";
  readonly startedAt: string | null;
  /** The subagent's own thread, when it has one to open. */
  readonly childThreadId: ThreadId | null;
  /** Thread whose provider session owns a background process. */
  readonly ownerThreadId?: ThreadId;
  /** Provider task kind and the program a background shell mostly runs. */
  readonly taskType?: string;
  readonly commandKind?: string;
  /** The running child thread's sidebar status, when the row is one. */
  readonly status?: SidebarThreadStatus | undefined;
  /** The running child thread, for its provider and model · effort label. */
  readonly child?: Pick<SidebarThreadSummary, "providerInstanceId" | "modelSelection"> | undefined;
}

/** Separates agents from the owner's processes without changing order within either group. */
export function groupBackgroundWorkTaskRows(rows: ReadonlyArray<BackgroundWorkTaskRow>) {
  return {
    agents: rows.filter((row) => row.kind === "subagent"),
    processes: rows.filter((row) => row.kind === "process"),
  };
}

/**
 * Joins each pending task back to the projection record it came from. Task ids are the turn
 * item's native id (or its id), matching `derivePendingBackgroundWork`; roster-only tasks
 * (Claude SDK background tasks) have no turn item and fall back to their `taskType`
 * (`local_agent`, `remote_agent` are agents; `local_bash` is a process).
 */
export function describeBackgroundWorkTasks(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems" | "subagents">,
): ReadonlyArray<BackgroundWorkTaskRow> {
  return tasks.map((task) => {
    const item = projection.turnItems.find(
      (candidate) => (candidate.nativeItemRef?.nativeId ?? candidate.id) === task.taskId,
    );
    const subagentId = item?.type === "subagent" ? item.subagentId : null;
    const subagent = projection.subagents.find(
      (candidate) =>
        candidate.id === subagentId || candidate.nativeTaskRef?.nativeId === task.taskId,
    );
    const startedAt = item?.startedAt ?? subagent?.startedAt ?? task.startedAt;
    const kind =
      item?.type === "subagent" || subagent !== undefined || isAgentTask(task)
        ? "subagent"
        : "process";
    return {
      taskId: task.taskId,
      label: task.description ?? task.taskId,
      kind,
      startedAt: isoOrNull(startedAt),
      childThreadId:
        (item?.type === "subagent" ? item.childThreadId : null) ?? subagent?.childThreadId ?? null,
      ...(kind === "process"
        ? {
            ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
            ...(task.commandKind === undefined ? {} : { commandKind: task.commandKind }),
          }
        : {}),
    };
  });
}

/**
 * Sidebar rows without loading the thread projection. Running subagent child threads carry the
 * link and start time; the pending roster (empty while the parent's own turn runs) adds
 * processes, plus agent tasks that no running child thread accounts for: a task naming its child
 * thread matches by id, the rest by count. A shell a listed child started nests under that child
 * (see `pendingBackgroundWorkOfThread`) and keeps a finished child waiting.
 */
export function describeSidebarBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  runningChildren: ReadonlyArray<
    Pick<
      SidebarThreadSummary,
      | "id"
      | "title"
      | "latestRun"
      | "runtime"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "providerInstanceId"
      | "modelSelection"
    >
  >,
  taskOwnerThreadIdById?: ReadonlyMap<string, ThreadId>,
): ReadonlyArray<BackgroundWorkTaskRow> {
  const listed = new Set<string>(runningChildren.map((child) => child.id));
  const linked = tasks.filter(isAgentTask).filter((task) => task.childThreadId !== undefined);
  const unlinked = tasks.filter(isAgentTask).filter((task) => task.childThreadId === undefined);
  // ponytail: roster-only tasks (Claude SDK background agents) carry no child thread id, so they
  // pair with the running children no linked task accounts for by count.
  const unmatchedChildren = runningChildren.filter(
    (child) => !linked.some((task) => task.childThreadId === child.id),
  ).length;
  const hasShells = (childId: string) =>
    heldBackgroundWork(pendingBackgroundWorkOfThread(childId, [], tasks)).length > 0;
  return [
    ...runningChildren.map((child) => {
      const ownStatus = resolveSidebarThreadStatus(child);
      const status =
        ownStatus === "ready" && hasShells(child.id) ? ("waiting" as const) : ownStatus;
      return {
        taskId: child.id,
        label: child.title,
        kind: "subagent" as const,
        startedAt: resolveThreadWorkingStartedAt({ ...child, waiting: status === "waiting" }),
        childThreadId: child.id,
        status,
        child,
      };
    }),
    ...[
      ...linked.filter((task) => !listed.has(task.childThreadId ?? "")),
      ...unlinked.slice(unmatchedChildren),
    ].map((task) => ({
      taskId: task.taskId,
      label: task.description ?? task.taskId,
      kind: "subagent" as const,
      startedAt: isoOrNull(task.startedAt),
      childThreadId: task.childThreadId ?? null,
    })),
    ...tasks
      .filter((task) => !isAgentTask(task) && !listed.has(task.childThreadId ?? ""))
      .map((task) => ({
        taskId: task.taskId,
        label: task.description ?? task.taskId,
        kind: "process" as const,
        startedAt: isoOrNull(task.startedAt),
        childThreadId: null,
        ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
        ...(task.commandKind === undefined ? {} : { commandKind: task.commandKind }),
        ...(taskOwnerThreadIdById?.get(task.taskId) === undefined
          ? {}
          : { ownerThreadId: taskOwnerThreadIdById.get(task.taskId)! }),
      })),
  ];
}
