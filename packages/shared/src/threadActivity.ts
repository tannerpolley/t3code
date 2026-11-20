import type {
  MessageId,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadShell,
  PlanId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  /**
   * The run is still open, but its provider turn already ended, so nothing is
   * generating while the server settles it.
   */
  readonly turnEnded?: boolean;
  /**
   * Set while the run is open but its provider has not started a turn, so the
   * provider is still launching and nothing is generating. Clients show it
   * instead of "Thinking".
   */
  readonly providerStartingLabel?: string;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly silentWakeAttention?: OrchestrationV2ThreadShell["silentWakeAttention"];
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly activityStartedAt?: string | null | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null;
  readonly lastErrorCode?: string | null;
  readonly usageLimitResetAt?: string | null;
  readonly updatedAt: string;
}

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

export interface ThreadActivityInput {
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null | undefined;
  readonly pendingGuestMessageCount?: number | undefined;
  readonly lastProviderActivityAt?: number | undefined;
  readonly hasActiveProviderWork?: boolean | undefined;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly runtime?: Pick<
    ThreadRuntimeSummary,
    "status" | "lastErrorClass" | "silentWakeAttention"
  > | null;
  readonly latestRun?: Pick<ThreadRunSummary, "status"> | null;
}

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
  if (thread.runtime?.silentWakeAttention !== undefined) return "failed";
  if (status === "failed" || thread.latestRun?.status === "failed") {
    return thread.runtime?.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  if (status === "idle" || backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []))
    return "waiting";
  return "ready";
}

export function threadActivityIsSettledRun(
  run: Pick<ThreadRunSummary, "runId" | "status"> | null,
  runtime: Partial<Pick<ThreadRuntimeSummary, "activeRunId">> | null,
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
function threadActivityShellRuntime(
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
    silentWakeAttention: thread.silentWakeAttention,
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

type WorkingThreadInput = ThreadActivityInput & {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: Exclude<
    ThreadActivityInput["pendingSubagentRequest"],
    undefined
  >;
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly hasActionableProposedPlan: boolean;
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "status"> | null;
  readonly runtime:
    | (NonNullable<ThreadActivityInput["runtime"]> &
        Partial<Pick<ThreadRuntimeSummary, "activeRunId">>)
    | null;
};

function isWorkingActivity(thread: WorkingThreadInput, activity: ThreadActivity): boolean {
  return (
    ["connecting", "working", "waiting"].includes(activity) &&
    !(
      thread.interactionMode === "plan" &&
      thread.hasActionableProposedPlan &&
      threadActivityIsSettledRun(thread.latestRun, thread.runtime)
    )
  );
}

export function isThreadWorking(
  thread: WorkingThreadInput & {
    readonly latestRun: ThreadRunSummary | null;
    readonly runtime: ThreadRuntimeSummary | null;
  },
): boolean {
  return isWorkingActivity(thread, resolveThreadActivity(thread));
}

export function visibleOpenPullRequest(pullRequests: readonly ThreadPullRequestLink[]) {
  return pullRequests.find(
    (pr) => pr.source !== "stack-dismissed" && pr.snapshot?.state === "open",
  );
}

export interface ThreadQuietClock {
  readonly nowMs: number;
  readonly quietMinutes: number;
  readonly samplingWindowMs?: number;
}

export function threadQuietMinutes(thread: ThreadActivityInput, clock: ThreadQuietClock) {
  if (
    clock.quietMinutes === 0 ||
    thread.runtime?.status !== "running" ||
    resolveThreadActivity(thread) !== "working" ||
    thread.hasActiveProviderWork ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    thread.lastProviderActivityAt === undefined
  ) {
    return null;
  }
  const minutes = Math.floor(
    (clock.nowMs - thread.lastProviderActivityAt - (clock.samplingWindowMs ?? 0)) / 60_000,
  );
  return minutes >= clock.quietMinutes ? minutes : null;
}

export function resolveThreadActivityGroup(
  thread: WorkingThreadInput & { readonly pullRequests: readonly ThreadPullRequestLink[] },
  clock?: ThreadQuietClock,
) {
  const activity = resolveThreadActivity(thread);
  if (
    activity === "approval" ||
    activity === "input" ||
    activity === "failed" ||
    activity === "limited" ||
    (clock !== undefined && threadQuietMinutes(thread, clock) !== null)
  ) {
    return "needs-you";
  }
  if (isWorkingActivity(thread, activity)) return "working";
  return visibleOpenPullRequest(thread.pullRequests) === undefined ? null : "ready-for-review";
}

export function isExplicitlyPausedThread(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "explicitStopRequested" | "activityRunStatus" | "pendingBackgroundTasks" | "archivedAt"
  >,
): boolean {
  return (
    thread.archivedAt === null &&
    thread.explicitStopRequested === true &&
    thread.activityRunStatus == null &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  );
}

export function threadActivityFromShell(thread: OrchestrationV2ThreadShell, requestVisible = true) {
  const request = requestVisible ? thread.pendingRuntimeRequest : null;
  const latestRun =
    thread.latestRunId === null
      ? null
      : ({
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt:
            thread.latestRunRequestedAt == null
              ? null
              : DateTime.formatIso(thread.latestRunRequestedAt),
          startedAt:
            thread.latestRunStartedAt == null
              ? null
              : DateTime.formatIso(thread.latestRunStartedAt),
          completedAt:
            thread.latestRunCompletedAt === undefined
              ? thread.status === "idle" ||
                ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  thread.status,
                )
                ? DateTime.formatIso(thread.updatedAt)
                : null
              : thread.latestRunCompletedAt === null
                ? null
                : DateTime.formatIso(thread.latestRunCompletedAt),
          assistantMessageId: null,
        } satisfies ThreadRunSummary);
  return {
    latestRun,
    runtime: threadActivityShellRuntime(thread),
    interactionMode: thread.interactionMode,
    blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
    lastProviderActivityAt:
      thread.delegatedFrom == null ? thread.lastProviderActivityAt : undefined,
    hasActiveProviderWork:
      thread.hasActiveProviderWork ||
      (!requestVisible && thread.pendingRuntimeRequest !== null) ||
      request?.kind === "auth_refresh",
    hasPendingApprovals:
      request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh",
    hasPendingUserInput: request?.kind === "user_input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    pendingBackgroundTasks: thread.pendingBackgroundTasks ?? [],
    pendingGuestMessageCount: thread.pendingGuestMessageCount ?? 0,
  };
}
