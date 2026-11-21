import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";
import {
  delegatedTaskAwaitsWork,
  delegatedTaskResultRun as selectTaskResultRun,
  delegatedTaskRuns,
} from "./RestartBackgroundNote.ts";
import type {
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2DelegatedCompletionCohort,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { runOutcome } from "./RestartBackgroundNote.ts";
import type { ProjectionStoreV2, ProjectionRecords } from "./ProjectionStore.ts";
import type {
  usageLimitSwitchMessageId,
  usageLimitSwitchResultRun,
} from "./usageLimitRecoveryPending.ts";

type ChildControls = ProjectionRecords<
  "runs" | "messages" | "subagents" | "providerThreads" | "providerTurns" | "attempts"
>;
type CompletionOptions = {
  readonly settledContinuationOf?: RunId;
  readonly syncRunId?: RunId;
  readonly resultRun?: OrchestrationV2Run;
};
type Progress = ReturnType<typeof delegatedTaskProgress>;
interface ForkDelegatedCompletionHooks<RecoveryError> {
  readonly usageLimitSwitchMessageId: typeof usageLimitSwitchMessageId;
  readonly usageLimitSwitchResultRun: typeof usageLimitSwitchResultRun;
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly childAwaitsRecoveryContinuation: (
    thread: OrchestrationV2AppThread,
    runs: ReadonlyArray<OrchestrationV2Run>,
    resultRun: OrchestrationV2Run,
    settledContinuationOf?: RunId,
  ) => Effect.Effect<boolean, RecoveryError>;
  readonly delegatedTaskTerminalStatus: (
    status: OrchestrationV2Run["status"],
  ) => OrchestrationV2Subagent["status"] | null;
  readonly isTerminalDelegatedTaskStatus: (status: OrchestrationV2Subagent["status"]) => boolean;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
}

// Runless managed admissions share the durable mailbox; the cohort lives on the thread itself.
export const completionCohort = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  parentRunId: RunId | null,
) =>
  parentRunId === null
    ? projection.thread.delegatedCompletion
    : projection.runs.find((run) => run.id === parentRunId)?.delegatedCompletion;

export function currentDelegatedCompletionDelivery(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "messages" | "runs" | "providerTurns"
  >,
  completion: { parentRunId: RunId | null; generation: number; messageId: MessageId },
) {
  const cohort = completionCohort(projection, completion.parentRunId);
  const delivery = cohort?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    cohort?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

export function completionCohortEvents(
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run | undefined,
  cohort: OrchestrationV2DelegatedCompletionCohort,
  now: DateTime.Utc,
): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> {
  const previous = run === undefined ? thread.delegatedCompletion : run.delegatedCompletion;
  const attention = thread.silentWakeAttention;
  const clear =
    attention !== undefined &&
    "deliveryMessageId" in attention &&
    attention.deliveryMessageId === previous?.delivery?.messageId &&
    (cohort.disposition !== "open" ||
      cohort.delivery?.messageId !== attention.deliveryMessageId ||
      cohort.delivery.taskIds.length === 0);
  const threadUpdate = {
    type: "thread.metadata-updated" as const,
    threadId: thread.id,
    occurredAt: now,
  };
  const parent = clear ? { ...thread, silentWakeAttention: undefined } : thread;
  if (run === undefined) {
    return [{ ...threadUpdate, payload: { ...parent, delegatedCompletion: cohort } }];
  }
  return [
    ...(clear ? [{ ...threadUpdate, payload: parent }] : []),
    {
      type: "run.updated",
      threadId: thread.id,
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, delegatedCompletion: cohort },
    },
  ];
}

// The orchestrator retains the upstream completion pipeline, reads, locks, and commits.
export function makeForkDelegatedCompletion<RecoveryError>({
  projectionStore,
  childAwaitsRecoveryContinuation,
  delegatedTaskTerminalStatus,
  isTerminalDelegatedTaskStatus,
  isBlockingRun,
  usageLimitSwitchMessageId,
  usageLimitSwitchResultRun,
}: ForkDelegatedCompletionHooks<RecoveryError>) {
  function delegatedTaskResultRun(
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
    taskId: NodeId,
  ) {
    const switched = usageLimitSwitchResultRun(projection.thread, projection.runs, taskId);
    const taskRuns = delegatedTaskRuns(projection, taskId).map((run) => {
      if (
        switched !== undefined &&
        run.startedAt === null &&
        run.userMessageId === usageLimitSwitchMessageId(projection.thread.id, switched.id)
      )
        return switched;
      // Promotion cancels the queue holder and moves its message into the live run.
      const message = projection.messages.find((row) => row.id === run.userMessageId);
      let result = projection.runs.find((row) => row.id === message?.runId) ?? run;
      for (;;) {
        const continuation = projection.runs.find(
          (row) =>
            row.ordinal > result.ordinal &&
            (row.restartContinuationOfRunId === result.id ||
              (row.userMessageId === usageLimitSwitchMessageId(projection.thread.id, result.id) &&
                row.startedAt !== null)),
        );
        if (continuation === undefined) return result;
        result = continuation;
      }
    });
    return selectTaskResultRun(
      [...taskRuns, ...(switched === undefined ? [] : [switched])].map((run) =>
        run.delegatedTaskId === taskId ? run : { ...run, delegatedTaskId: taskId },
      ),
    );
  }

  const closedChildResult = Effect.fnUntraced(function* (
    childControls: ChildControls,
    options: CompletionOptions,
  ) {
    const recordedRun = options.resultRun;
    if (recordedRun === undefined) return;
    const closed =
      childControls.thread.archivedAt !== null || childControls.thread.deletedAt !== null;
    const childRun =
      closed && delegatedTaskTerminalStatus(runOutcome(recordedRun)) === null
        ? { ...recordedRun, status: "interrupted" as const, completedAt: yield* DateTime.now }
        : recordedRun;
    return { closed, childRun };
  });
  // The one "is this result still owed work" decision behind task_status, wait and the parent wake.
  const taskResultPending = Effect.fnUntraced(function* (
    childThreadId: ThreadId,
    taskId: NodeId | undefined,
    child: ChildControls,
  ) {
    if (taskId !== undefined) {
      const run = delegatedTaskResultRun(child, taskId);
      if (
        run === undefined ||
        child.thread.archivedAt !== null ||
        child.thread.deletedAt !== null
      ) {
        const parentThreadId = child.thread.lineage.parentThreadId;
        if (parentThreadId === null) return true;
        const parent = yield* projectionStore.getThreadRecords(parentThreadId, ["subagents"], {
          subagentIds: [taskId],
        });
        return !parent.subagents.some(
          (task) =>
            task.id === taskId &&
            task.childThreadId === childThreadId &&
            task.origin === "app_owned" &&
            task.result !== null &&
            isTerminalDelegatedTaskStatus(task.status),
        );
      }
      if (
        delegatedTaskTerminalStatus(run.status) === null ||
        delegatedTaskAwaitsWork(delegatedTaskRuns(child, taskId), child)
      )
        return true;
      return yield* childAwaitsRecoveryContinuation(child.thread, child.runs, run);
    }
    const shell = yield* projectionStore.getThreadShell(childThreadId);
    const progress = delegatedTaskProgress({
      ...child,
      pendingBackgroundTasks: shell?.pendingBackgroundTasks ?? [],
    });
    if (progress.state !== "result_available") return true;
    if (progress.resultRun === undefined) return false;
    return yield* childAwaitsRecoveryContinuation(child.thread, child.runs, progress.resultRun);
  });
  const recoverDeletedChildren = Effect.fnUntraced(function* <FinalizeError, WithdrawError>(
    tasks: ReadonlyArray<OrchestrationV2Subagent>,
    finalizeAppOwnedSubagent: (threadId: ThreadId) => Effect.Effect<void, FinalizeError>,
    withdrawReleasedUsageLimitContinuation: (
      threadId: ThreadId,
    ) => Effect.Effect<void, WithdrawError>,
  ) {
    const childIds = new Set(
      tasks.flatMap((task) =>
        task.origin === "app_owned" && task.result === null && task.childThreadId !== null
          ? [task.childThreadId]
          : [],
      ),
    );
    for (const childId of childIds) {
      const child = yield* projectionStore.getThread(childId);
      if (child.deletedAt === null) continue;
      yield* finalizeAppOwnedSubagent(childId);
      yield* withdrawReleasedUsageLimitContinuation(childId);
    }
  });
  const orphanedFollowupUnavailable = (
    childControls: ChildControls,
    task: OrchestrationV2Subagent,
    closed: boolean,
    progress: Progress,
    latest: OrchestrationV2Run,
  ) => {
    return (
      !closed &&
      (progress.state !== "result_available" ||
        childControls.runs.some((run) => isBlockingRun(run) || run.status === "queued") ||
        latest.completedAt === null ||
        task.startedAt === null ||
        DateTime.toEpochMillis(latest.completedAt) < DateTime.toEpochMillis(task.startedAt))
    );
  };
  const hasPublishedResult = (task: OrchestrationV2Subagent) => task.result !== null;
  return {
    delegatedTaskResultRun,
    closedChildResult,
    taskResultPending,
    recoverDeletedChildren,
    orphanedFollowupUnavailable,
    hasPublishedResult,
  };
}
