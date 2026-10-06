import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import type { IssueWorkStatus, OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import { runtimeRequestNeedsUser } from "../orchestration-v2/SubagentProjection.ts";

/** Derive issue progress from orchestration state so status cannot drift from runs and children. */
export function deriveIssueWorkStatus(input: {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    | "deletedAt"
    | "archivedAt"
    | "pendingRuntimeRequest"
    | "status"
    | "activityRunStatus"
    | "activeRunId"
    | "pendingBackgroundTasks"
  > | null;
  readonly paused: boolean;
  readonly waitingOnSubIssues: boolean;
  readonly resultAvailable?: boolean;
  readonly queued?: boolean;
  readonly runtimeRequests?: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "kind" | "status">>;
}): IssueWorkStatus {
  const { shell } = input;
  if (input.paused) return "paused";
  if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
    return "unavailable";
  }
  const needsUser =
    input.runtimeRequests === undefined
      ? shell.pendingRuntimeRequest !== null &&
        runtimeRequestNeedsUser(shell.pendingRuntimeRequest.kind)
      : input.runtimeRequests.some(
          (request) => request.status === "pending" && runtimeRequestNeedsUser(request.kind),
        );
  if (needsUser) return "waiting_on_you";
  if (input.queued === true) {
    if (shell.status === "failed") return "failed";
    if (shell.status === "interrupted" || shell.status === "rolled_back") return "interrupted";
    if (shell.status === "cancelled") return "cancelled";
    return "queued_preparing";
  }
  if (
    ["queued", "preparing", "starting"].includes(shell.status) ||
    shell.activityRunStatus === "preparing" ||
    shell.activityRunStatus === "starting"
  ) {
    return "queued_preparing";
  }
  if (
    shell.activeRunId !== null ||
    shell.status === "running" ||
    shell.status === "waiting" ||
    shell.activityRunStatus === "running" ||
    shell.activityRunStatus === "waiting"
  )
    return "working";
  if (
    input.waitingOnSubIssues ||
    (shell.pendingBackgroundTasks ?? []).some((task) => task.kind !== "monitor")
  ) {
    return "waiting_on_sub_issues";
  }
  switch (shell.status) {
    case "completed":
      return input.resultAvailable === true ? "done" : "working";
    case "failed":
      return "failed";
    case "interrupted":
    case "rolled_back":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    case "idle":
      return "queued_preparing";
    case "queued":
    case "preparing":
    case "starting":
      return "queued_preparing";
  }
}
