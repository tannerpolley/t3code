import type {
  IssuePullRequestStatus,
  OrchestrationV2ThreadShell,
  RepositoryIssueSummary,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  managedImplementorAwaitingSubagent,
} from "./orchestrationV2PendingBackgroundWork.ts";
import {
  runtimeRequestIsOwnerVisible,
  type RoutedRequestParent,
} from "./delegatedRequestVisibility.ts";
import { isExplicitlyPausedThread } from "./threadActivity.ts";

type Worker = NonNullable<RepositoryIssueSummary["liveWork"]>[number];
type WorkerState = Pick<Worker, "status" | "requestHandledByParent" | "paused">;

export function isIssueWorkerChild(
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "linkedIssue">,
) {
  return thread.lineage.parentThreadId !== null && thread.linkedIssue !== undefined;
}

export function issueWorkerIsWorking(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activityRunStatus"
    | "explicitStopRequested"
    | "archivedAt"
    | "role"
    | "lineage"
    | "linkedIssue"
    | "pendingBackgroundTasks"
  >,
): boolean {
  const status = thread.activityRunStatus ?? thread.status;
  if (thread.archivedAt !== null || status === "queued") return false;
  const tasks = thread.pendingBackgroundTasks ?? [];
  return (
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    managedImplementorAwaitingSubagent(thread) ||
    (status !== "failed" &&
      !isExplicitlyPausedThread(thread) &&
      isIssueWorkerChild(thread) &&
      tasks.some((task) => task.kind === "command")) ||
    (status === "waiting" &&
      !tasks.some((task) => task.kind === "monitor") &&
      !backgroundWorkHoldsCompletion(tasks))
  );
}

export function classifyIssueWorker(
  thread: Parameters<typeof issueWorkerIsWorking>[0] & {
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
  if (issueWorkerIsWorking(thread)) return { status: "working" };
  if (status === "failed") return { status: "failed" };
  return isExplicitlyPausedThread(thread) ? { status: "idle", paused: true } : { status: "idle" };
}

export function issueWorkerStatus(
  worker: WorkerState & { readonly pullRequests?: readonly string[] | undefined },
  issue: {
    readonly state?: RepositoryIssueSummary["state"] | undefined;
    readonly pullRequests?: readonly IssuePullRequestStatus[] | undefined;
  },
) {
  if (worker.paused) return "paused";
  if (worker.status !== "idle" && worker.status !== "done") return worker.status;
  if (issue.state === "closed") return "done";
  const urls = worker.pullRequests?.map((url) => url.toLowerCase());
  let open = false;
  for (const pr of issue.pullRequests ?? []) {
    const url = pr.url ?? `https://${pr.host}/${pr.repository}/pull/${pr.number}`;
    if (!urls?.includes(url.toLowerCase())) continue;
    if (pr.state === "merged") return "done";
    if (pr.state === "open") open = true;
  }
  return open ? "ready_for_review" : "idle";
}

export function issueWorkerNeedsOwner({ status }: WorkerState) {
  return status === "question" || status === "approval" || status === "waiting_on_you";
}

export function issueWorkerIsLive(worker: WorkerState & Pick<Worker, "inherited">) {
  return issueWorkerNeedsOwner(worker) || (!worker.inherited && worker.status === "working");
}
