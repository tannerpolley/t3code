import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * When a thread last did anything, or null while it holds work: a queued or
 * live run, a pending approval or user input, or a subagent still working.
 * Idle agent session disconnects use this both to pick threads and to
 * re-check them under the orchestrator's thread lock.
 */
export function threadIdleSinceMs(records: {
  readonly thread: Pick<OrchestrationV2AppThread, "createdAt">;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "status" | "requestedAt" | "startedAt" | "completedAt">
  >;
  readonly runtimeRequests: ReadonlyArray<
    Pick<OrchestrationV2RuntimeRequest, "status" | "createdAt" | "resolvedAt">
  >;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status" | "updatedAt">>;
}): number | null {
  if (records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return null;
  if (records.runtimeRequests.some((request) => request.status === "pending")) return null;
  if (records.subagents.some((subagent) => isOrchestrationV2WorkActive(subagent.status))) {
    return null;
  }
  const times = [
    records.thread.createdAt,
    ...records.runs.flatMap((run) => [run.requestedAt, run.startedAt, run.completedAt]),
    ...records.runtimeRequests.flatMap((request) => [request.createdAt, request.resolvedAt]),
    ...records.subagents.map((subagent) => subagent.updatedAt),
  ];
  return Math.max(...times.map((time) => (time === null ? 0 : DateTime.toEpochMillis(time))));
}
