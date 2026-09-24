import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
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

/** `subagent` turn items and Claude's `local_agent` / `remote_agent` roster entries are agents. */
function isAgentTask(task: OrchestrationV2PendingBackgroundTask): boolean {
  return /agent/.test(task.taskType ?? "");
}

/**
 * Sidebar rows without loading the thread projection. Running subagent child threads carry the
 * link and start time; the pending roster (empty while the parent's own turn runs) adds
 * processes, plus agent tasks that no running child thread accounts for.
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
  const agentTasks = tasks.filter(isAgentTask);
  return [
    ...runningChildren.map((child) => ({
      taskId: child.id,
      label: child.title,
      kind: "subagent" as const,
      startedAt: resolveThreadWorkingStartedAt(child),
      childThreadId: child.id,
      status: resolveSidebarThreadStatus(child),
      child,
    })),
    // ponytail: the shell has no task id on child threads, so agent tasks pair with children by
    // count; join on an id if the summary ever carries one.
    ...agentTasks.slice(runningChildren.length).map((task) => ({
      taskId: task.taskId,
      label: task.description ?? task.taskId,
      kind: "subagent" as const,
      startedAt: null,
      childThreadId: null,
    })),
    ...tasks
      .filter((task) => !isAgentTask(task))
      .map((task) => ({
        taskId: task.taskId,
        label: task.description ?? task.taskId,
        kind: "process" as const,
        startedAt: null,
        childThreadId: null,
      })),
  ];
}
