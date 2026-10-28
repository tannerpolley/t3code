import type {
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
import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { deriveIssueWorkStatus } from "../issues/IssueWorkStatus.ts";
import { issueCloseoutEffect } from "../issues/IssueCommentEffects.ts";
import { runOutcome } from "./RestartBackgroundNote.ts";
import type { ProjectionStoreV2, ProjectionRecords } from "./ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
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
interface ForkDelegatedCompletionHooks<WriteError, RecoveryError> {
  readonly usageLimitSwitchMessageId: typeof usageLimitSwitchMessageId;
  readonly usageLimitSwitchResultRun: typeof usageLimitSwitchResultRun;
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
    effects?: ReadonlyArray<PendingOrchestrationEffectV2>,
    options?: { readonly updateDelegatedCompletionOnly?: boolean },
  ) => Effect.Effect<void, WriteError>;
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

export const completionCohortEvent = (
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run | undefined,
  cohort: OrchestrationV2DelegatedCompletionCohort,
  now: DateTime.Utc,
): Omit<OrchestrationV2DomainEvent, "id"> =>
  run === undefined
    ? {
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, delegatedCompletion: cohort },
      }
    : {
        type: "run.updated",
        threadId: thread.id,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, delegatedCompletion: cohort },
      };

// The orchestrator retains the upstream completion pipeline, reads, locks, and commits.
export function makeForkDelegatedCompletion<WriteError, RecoveryError>({
  projectionStore,
  writeSystemEvents,
  childAwaitsRecoveryContinuation,
  delegatedTaskTerminalStatus,
  isTerminalDelegatedTaskStatus,
  isBlockingRun,
  usageLimitSwitchMessageId,
  usageLimitSwitchResultRun,
}: ForkDelegatedCompletionHooks<WriteError, RecoveryError>) {
  function delegatedTaskResultRun(
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
    taskId: NodeId,
  ) {
    const taskRuns = projection.runs
      .filter((run) => run.delegatedTaskId === taskId)
      .map((run) => {
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
    return (
      usageLimitSwitchResultRun(projection.thread, projection.runs, taskId) ??
      taskRuns.toSorted((a, b) => b.ordinal - a.ordinal)[0]
    );
  }

  const publishIssueCloseout = Effect.fn("Orchestrator.publishIssueCloseout")(function* (
    childControls: ProjectionRecords<
      "runs" | "messages" | "subagents" | "providerThreads" | "providerTurns" | "attempts"
    >,
    childRun: OrchestrationV2Run,
  ) {
    const issue = childControls.thread.linkedIssue;
    if (issue === undefined) return;
    const root = yield* projectionStore
      .getThread(childControls.thread.lineage.rootThreadId)
      .pipe(Effect.option);
    if (Option.isNone(root) || root.value.repositoryOrchestration?.publishCloseoutComments !== true)
      return;
    const childResult = yield* projectionStore.getThreadRecords(
      childControls.thread.id,
      ["messages", "turnItems"],
      {
        messageRoles: ["assistant"],
        messageRunIds: [childRun.id],
        turnItemRunId: childRun.id,
        turnItemTypes: ["assistant_message", "error"],
      },
    );
    yield* writeSystemEvents(
      [],
      [
        issueCloseoutEffect({
          issue,
          thread: childControls.thread,
          runId: childRun.id,
          status: deriveIssueWorkStatus({
            shell: yield* projectionStore.getThreadShell(childControls.thread.id),
            paused: false,
            waitingOnSubIssues: false,
            resultAvailable: true,
          }),
          completedAt: yield* DateTime.now,
          result: subagentResultForRun(
            {
              ...childControls,
              messages: childResult.messages,
              turnItems: childResult.turnItems,
            },
            childRun,
          ).text,
        }),
      ],
    );
  });

  // These hooks run inside the existing completion or recovery operation.
  const publishUntaggedIssueCloseout = Effect.fnUntraced(function* (
    childControls: ChildControls,
    progress: Progress,
    options?: CompletionOptions,
  ) {
    if (
      progress.state === "result_available" &&
      progress.resultRun !== undefined &&
      progress.resultRun.delegatedTaskId === undefined &&
      !(yield* childAwaitsRecoveryContinuation(
        childControls.thread,
        childControls.runs,
        progress.resultRun,
        options?.settledContinuationOf,
      ))
    ) {
      yield* publishIssueCloseout(childControls, progress.resultRun);
    }
  });
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
        const parent = yield* projectionStore.getThreadRecords(parentThreadId, ["subagents"]);
        return !parent.subagents.some(
          (task) =>
            task.id === taskId &&
            task.childThreadId === childThreadId &&
            task.origin === "app_owned" &&
            task.result !== null &&
            isTerminalDelegatedTaskStatus(task.status),
        );
      }
      if (delegatedTaskTerminalStatus(run.status) === null) return true;
      return yield* childAwaitsRecoveryContinuation(child.thread, child.runs, run);
    }
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
    publishIssueCloseout,
    publishUntaggedIssueCloseout,
    closedChildResult,
    taskResultPending,
    recoverDeletedChildren,
    orphanedFollowupUnavailable,
    hasPublishedResult,
  };
}
