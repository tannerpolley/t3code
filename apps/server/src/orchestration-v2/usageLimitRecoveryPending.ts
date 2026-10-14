import {
  MessageId,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type RunId,
  type UsageLimitRecoveryMode,
} from "@t3tools/contracts";
import { threadErrorSummary } from "@t3tools/shared/orchestrationV2ThreadError";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import { isSnoozed } from "./ThreadSettlementService.ts";

export const USAGE_LIMIT_SWITCH_HOLD_MS = 2 * 60 * 1_000;
export const USAGE_LIMIT_SWITCH_RESUME_PREFIX = "limit-switch-resume:";
export const usageLimitSwitchMessageId = (threadId: ThreadId, runId: RunId) =>
  MessageId.make(`${USAGE_LIMIT_SWITCH_RESUME_PREFIX}${threadId}:${runId}`);

/** An unstarted switch continuation still answers the failed run, until its bounded hold expires. */
export function usageLimitSwitchResultRun(
  thread: OrchestrationV2AppThread,
  runs: readonly OrchestrationV2Run[],
  taskId: NodeId,
): OrchestrationV2Run | undefined {
  const marker = thread.autoProviderSwitch;
  const source = runs.find((run) => run.id === marker?.runId && run.status === "failed");
  if (
    !source ||
    (source.delegatedTaskId ??
      (thread.forkedFrom?.type === "node" ? thread.forkedFrom.nodeId : undefined)) !== taskId
  )
    return undefined;
  const continuation = runs.find(
    (run) => run.userMessageId === usageLimitSwitchMessageId(thread.id, source.id),
  );
  return continuation?.startedAt != null ? undefined : source;
}

/** Only Switch provider gets a short hold; the persisted failure time survives restarts. */
export function usageLimitRecoveryPending(
  shell: OrchestrationV2ThreadShell | null,
  run: OrchestrationV2Run,
  failure: OrchestrationV2ProviderFailure | null,
  runs: readonly OrchestrationV2Run[],
  mode: UsageLimitRecoveryMode,
  driver: string | undefined,
  nowMs: number,
): boolean {
  if (
    !shell ||
    mode !== "switch" ||
    run.status !== "failed" ||
    threadErrorSummary(failure, shell.lastError ?? null).lastErrorClass !== "usage_limit" ||
    shell.archivedAt !== null ||
    shell.deletedAt !== null ||
    shell.settledOverride === "settled" ||
    isSnoozed(shell, nowMs) ||
    nowMs >= DateTime.toEpochMillis(run.completedAt ?? run.requestedAt) + USAGE_LIMIT_SWITCH_HOLD_MS
  )
    return false;
  const marker = shell.autoProviderSwitch?.runId === run.id ? shell.autoProviderSwitch : undefined;
  if (marker?.to === null) return false;
  const continuation = runs.find(
    (candidate) => candidate.userMessageId === usageLimitSwitchMessageId(shell.id, run.id),
  );
  if (continuation?.status === "cancelled") return false;
  return (
    modelSelectionsEqual(shell.modelSelection, marker?.to ?? run.modelSelection) &&
    (marker !== undefined || driver === "codex" || driver === "claudeAgent")
  );
}
