import type {
  ProviderInstanceId,
  RepositoryOrchestration,
  RepositoryUsageSprint,
  RepositoryUsageSprintEndReason,
  ServerProvider,
  ThreadId,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// Probes repeat a reset time with small jitter; a real reset moves it by hours or days.
const RESET_MOVE_TOLERANCE_MS = 60_000;
const USAGE_DROP_TOLERANCE_PERCENT = 1;

/** The weekly window a sprint on this provider runs against, preferring Claude's all-model week. */
export function usageSprintWindow(provider: ServerProvider, nowMs: number) {
  const weekly = (provider.usageLimits?.windows ?? []).filter(
    (window) =>
      window.kind === "weekly" &&
      window.resetsAt !== undefined &&
      Date.parse(window.resetsAt) > nowMs,
  );
  return weekly.find((window) => window.id === "seven_day") ?? weekly[0];
}

/** Why a sprint ends now (its scheduled reset passed, or the window reset early), or its usage peak so far. */
export function usageSprintCheck(
  sprint: RepositoryUsageSprint,
  provider: ServerProvider | undefined,
  nowMs: number,
):
  | { readonly end: Exclude<RepositoryUsageSprintEndReason, "stopped"> }
  | { readonly peak: number } {
  if (nowMs >= Date.parse(sprint.resetsAt)) return { end: "reset" };
  const window = provider?.usageLimits?.windows.find((entry) => entry.id === sprint.windowId);
  if (window?.resetsAt === undefined) return { peak: sprint.usedPercent };
  return Math.abs(Date.parse(window.resetsAt) - Date.parse(sprint.resetsAt)) >
    RESET_MOVE_TOLERANCE_MS ||
    window.usedPercent + USAGE_DROP_TOLERANCE_PERCENT < sprint.usedPercent
    ? { end: "early_reset" }
    : { peak: Math.max(sprint.usedPercent, window.usedPercent) };
}

/** Why a sprint refuses a target on `instanceId`, or null when the target is allowed. */
export function usageSprintRefusal(
  sprint: RepositoryUsageSprint | undefined,
  instanceId: ProviderInstanceId,
): string | null {
  return sprint === undefined || sprint.providerInstanceId === instanceId
    ? null
    : `A one-time usage sprint limits this repository's work to provider ${sprint.providerInstanceId} until ${sprint.resetsAt}. Choose a ${sprint.providerInstanceId} target instead of ${instanceId}.`;
}

type SprintThread = {
  readonly lineage: { readonly rootThreadId: ThreadId };
  readonly repositoryOrchestration?: RepositoryOrchestration | undefined;
};

/** The active sprint of the repository orchestration this thread roots or descends from. */
export const lineageUsageSprint = <E, R>(
  thread: SprintThread,
  getRoot: (threadId: ThreadId) => Effect.Effect<SprintThread | null | undefined, E, R>,
): Effect.Effect<RepositoryUsageSprint | undefined, E, R> =>
  (thread.repositoryOrchestration === undefined
    ? getRoot(thread.lineage.rootThreadId).pipe(Effect.map((root) => root?.repositoryOrchestration))
    : Effect.succeed(thread.repositoryOrchestration)
  ).pipe(
    Effect.map((config) =>
      config?.retiredToThreadId === undefined ? config?.usageSprint : undefined,
    ),
  );

const REASON_TEXT: Record<RepositoryUsageSprintEndReason, string> = {
  reset: "its weekly usage window reset on schedule",
  early_reset: "its weekly usage reset early",
  stopped: "the user stopped it",
};

export function usageSprintEndMessage(input: {
  readonly sprint: RepositoryUsageSprint;
  readonly reason: RepositoryUsageSprintEndReason;
  readonly endedAt: string;
  readonly stopped: ReadonlyArray<ThreadLinkedIssue>;
}): string {
  const stopped =
    input.reason === "stopped"
      ? "Running work was left running."
      : input.stopped.length === 0
        ? "No issue work was running."
        : `T3 stopped the running work of these issues; their worktrees, branches and commits are kept: ${input.stopped
            .map((issue) => `#${issue.number} ${issue.title}`)
            .join("; ")}.`;
  return `The one-time usage sprint on ${input.sprint.providerInstanceId} ended at ${input.endedAt} because ${REASON_TEXT[input.reason]}. ${stopped}\n\nFollow your normal instructions and model roles again; the sprint's provider restriction no longer applies. Resume any stopped work the normal way.`;
}
