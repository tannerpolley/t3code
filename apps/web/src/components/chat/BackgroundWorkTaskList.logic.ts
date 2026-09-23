import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface BackgroundWorkTaskRow {
  readonly taskId: string;
  readonly label: string;
  readonly kind: "subagent" | "process";
  readonly startedAt: string | null;
  /** The subagent's own thread, when it has one to open. */
  readonly childThreadId: ThreadId | null;
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
        item?.type === "subagent" || subagent !== undefined || /agent/.test(task.taskType ?? "")
          ? "subagent"
          : "process",
      startedAt: startedAt === null ? null : DateTime.formatIso(startedAt),
      childThreadId:
        (item?.type === "subagent" ? item.childThreadId : null) ?? subagent?.childThreadId ?? null,
    };
  });
}
