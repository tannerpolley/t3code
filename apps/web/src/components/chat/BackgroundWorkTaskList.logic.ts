import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import {
  isAgentBackgroundTask as isAgentTask,
  pendingBackgroundWorkOfThread,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export interface BackgroundWorkTaskRow {
  readonly taskId: string;
  readonly label: string;
  readonly kind: "subagent" | "process";
  readonly startedAt: string | null;
  /** The subagent's own thread, when it has one to open. */
  readonly childThreadId: ThreadId | null;
  /** The running child thread's sidebar status, when the row is one. */
  readonly status?: SidebarThreadStatus | undefined;
  /** The running child thread, for its provider and model · effort label. */
  readonly child?: Pick<SidebarThreadSummary, "providerInstanceId" | "modelSelection"> | undefined;
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
    const startedAt = item?.startedAt ?? subagent?.startedAt ?? null;
    return {
      taskId: task.taskId,
      label: task.description ?? task.taskId,
      kind:
        item?.type === "subagent" || subagent !== undefined || isAgentTask(task)
          ? "subagent"
          : "process",
      startedAt: startedAt === null ? null : DateTime.formatIso(startedAt),
      childThreadId:
        (item?.type === "subagent" ? item.childThreadId : null) ?? subagent?.childThreadId ?? null,
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
    pendingBackgroundWorkOfThread(childId, [], tasks).length > 0;
  return [
    ...runningChildren.map((child) => {
      const status = resolveSidebarThreadStatus(child);
      return {
        taskId: child.id,
        label: child.title,
        kind: "subagent" as const,
        startedAt: resolveThreadWorkingStartedAt(child),
        childThreadId: child.id,
        status: status === "ready" && hasShells(child.id) ? ("waiting" as const) : status,
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
      startedAt: null,
      childThreadId: task.childThreadId ?? null,
    })),
    ...tasks
      .filter((task) => !isAgentTask(task) && !listed.has(task.childThreadId ?? ""))
      .map((task) => ({
        taskId: task.taskId,
        label: task.description ?? task.taskId,
        kind: "process" as const,
        startedAt: null,
        childThreadId: null,
      })),
  ];
}
