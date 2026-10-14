import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  ServerSettings,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

export function usageLimitRecoveryPending(
  thread: OrchestrationV2AppThread,
  run: OrchestrationV2Run,
  failure: OrchestrationV2ProviderFailure | null,
  settings: ServerSettings,
  driver: string | undefined,
): boolean {
  if (
    run.status !== "failed" ||
    failure?.class !== "usage_limit" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.repositoryOrchestration?.retiredToThreadId !== undefined
  )
    return false;
  const marker =
    thread.autoProviderSwitch?.runId === run.id ? thread.autoProviderSwitch : undefined;
  if (marker?.to != null) return modelSelectionsEqual(thread.modelSelection, marker.to);
  if (!modelSelectionsEqual(thread.modelSelection, run.modelSelection)) return false;
  const recovery = thread.limitRecovery?.runId === run.id ? thread.limitRecovery : undefined;
  if (recovery !== undefined) return recovery.autoResume;
  if (
    settings.usageLimitRecovery === "switch" &&
    marker === undefined &&
    (driver === "codex" || driver === "claudeAgent")
  )
    return true;
  const reset = Date.parse(failure.resetAt ?? "");
  if (
    !Number.isFinite(reset) ||
    reset <= DateTime.toEpochMillis(run.completedAt ?? thread.updatedAt)
  )
    return false;
  return (
    settings.usageLimitRecovery === "switch" ||
    (settings.usageLimitRecovery === "wait" && settings.autoResumeLimitedThreads)
  );
}
