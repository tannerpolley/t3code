import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell, ThreadRuntimeSummary, ThreadRunSummary } from "./models.ts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export type ThreadActivity =
  | "approval"
  | "input"
  | "request"
  | "waiting"
  | "connecting"
  | "working"
  | "limited"
  | "failed"
  | "ready";

export type ThreadActivityInput = {
  [
    K in
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "pendingSubagentRequest"
      | "pendingGuestMessageCount"
      | "blockedOnThreadWait"
      | "pendingBackgroundTasks"
  ]?: EnvironmentThreadShell[K] | undefined;
} & {
  readonly runtime?: Pick<ThreadRuntimeSummary, "status" | "lastErrorClass"> | null;
  readonly latestRun?: Pick<ThreadRunSummary, "status"> | null;
};

// Owner requests > live execution (queued/blocked, connecting, working) > failure > background wait > ready.
// A live execution supersedes a previous failed run; a failure supersedes its remaining background work.
export function resolveThreadActivity(thread: ThreadActivityInput): ThreadActivity {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  const status = thread.runtime?.status;
  if (status === "queued" || (status === "running" && thread.blockedOnThreadWait)) return "waiting";
  if (status === "preparing" || status === "starting") return "connecting";
  if (status === "running" || status === "waiting") return "working";
  if (status === "failed" || thread.latestRun?.status === "failed") {
    return thread.runtime?.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  if (status === "idle" || backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []))
    return "waiting";
  return "ready";
}

export function threadActivityIsSettledRun(
  run: Pick<ThreadRunSummary, "runId" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "activeRunId"> | null,
): boolean {
  return (
    run !== null &&
    !["preparing", "queued", "starting", "running", "waiting"].includes(run.status) &&
    runtime?.activeRunId !== run.runId
  );
}

// Only work the agent waits on holds it: commands and monitors it left running
// unmarked, such as a dev server, present the run's own status. The
// server suppresses the roster while an interruptible activity run exists, so a
// remaining roster is stronger than checkpoint-oriented waiting.
export function threadActivityShellRuntime(
  thread: OrchestrationV2ThreadShell,
): ThreadRuntimeSummary | null {
  const parkAtIdle =
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
    resolveThreadActivity({ runtime: { status: thread.status } }) !== "failed";
  // A pull request watch can hold a thread that never ran, and a provider-native
  // child without an app run still reports its own status.
  if (
    thread.latestRunId === null &&
    thread.activeProviderThreadId === null &&
    thread.status === "idle" &&
    !parkAtIdle
  ) {
    return null;
  }
  const status = parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
  return {
    status,
    activeRunId: thread.activeRunId,
    activityStartedAt:
      thread.activityRunStartedAt === undefined
        ? undefined
        : thread.activityRunStartedAt === null
          ? null
          : DateTime.formatIso(thread.activityRunStartedAt),
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: thread.lastError ?? null,
    lastErrorClass: thread.lastErrorClass ?? null,
    lastErrorCode: thread.lastErrorCode ?? null,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    updatedAt: DateTime.formatIso(thread.updatedAt),
  };
}

export function threadActivityWorkingStartedAt(input: {
  readonly latestRun: Pick<
    ThreadRunSummary,
    "runId" | "startedAt" | "requestedAt" | "completedAt"
  > | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "activeRunId" | "activityStartedAt"> | null;
  /** Waiting on its own background work: keep counting from the run that started it. */
  readonly waiting?: boolean;
}): string | null {
  const valid = (value: string | null | undefined) =>
    value != null && Number.isFinite(Date.parse(value)) ? value : null;
  const run = input.latestRun;
  const runStartedAt = valid(run?.startedAt) ?? valid(run?.requestedAt);
  const working =
    input.runtime?.activityStartedAt !== undefined
      ? valid(input.runtime.activityStartedAt)
      : run?.completedAt === null && run.runId === input.runtime?.activeRunId
        ? runStartedAt
        : null;
  return working ?? (input.waiting ? runStartedAt : null);
}
