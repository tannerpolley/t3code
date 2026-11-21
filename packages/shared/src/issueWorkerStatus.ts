import type { OrchestrationV2ThreadShell, RepositoryIssueSummary } from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  managedImplementorAwaitingSubagent,
} from "./orchestrationV2PendingBackgroundWork.ts";
import {
  runtimeRequestIsOwnerVisible,
  type RoutedRequestParent,
} from "./delegatedRequestVisibility.ts";

type Worker = NonNullable<RepositoryIssueSummary["liveWork"]>[number];
type WorkerState = Pick<Worker, "status" | "requestHandledByParent">;

export function classifyIssueWorker(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activityRunStatus"
    | "archivedAt"
    | "role"
    | "lineage"
    | "linkedIssue"
    | "pendingBackgroundTasks"
  > & {
    readonly pendingRuntimeRequest: Pick<
      NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>,
      "kind" | "routedTo"
    > | null;
  },
  parent?: RoutedRequestParent,
): WorkerState {
  if (thread.archivedAt !== null) return { status: "idle" };
  const request = thread.pendingRuntimeRequest?.kind;
  if (request !== undefined && request !== "auth_refresh" && request !== "dynamic_tool_call") {
    return {
      status: request === "user_input" ? "question" : "approval",
      ...(runtimeRequestIsOwnerVisible(thread.pendingRuntimeRequest, parent)
        ? {}
        : { requestHandledByParent: true }),
    };
  }
  const status = thread.activityRunStatus ?? thread.status;
  if (status === "queued") return { status: "queued" };
  if (
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    managedImplementorAwaitingSubagent(thread) ||
    (status === "waiting" &&
      !thread.pendingBackgroundTasks?.some((task) => task.kind === "monitor") &&
      !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []))
  )
    return { status: "working" };
  if (status === "failed") return { status: "failed" };
  if (
    status === "completed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "rolled_back"
  )
    return { status: "done" };
  return { status: "idle" };
}

export function issueWorkerNeedsOwner({ status }: WorkerState) {
  return status === "question" || status === "approval" || status === "waiting_on_you";
}

export function issueWorkerIsLive(worker: WorkerState & Pick<Worker, "inherited">) {
  return issueWorkerNeedsOwner(worker) || (!worker.inherited && worker.status === "working");
}
