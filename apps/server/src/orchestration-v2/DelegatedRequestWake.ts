import {
  CommandId,
  type ThreadId,
  type RuntimeRequestId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "./ProjectionStore.ts";
import {
  delegatedRequestNoticeId,
  delegatedRequestOwner,
  delegatedRequestDetails,
  delegatedRequestResponseInstructions,
} from "./DelegatedRequestRouting.ts";

/** Admit the full prompt through the parent's normal message dispatch, under its lock. */
export const delegatedRequestWakeCommand = Effect.fn("delegatedRequestWakeCommand")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
) {
  const owner = yield* delegatedRequestOwner(projections, childThreadId);
  if (owner === undefined) return;
  const child = yield* projections.getThreadRecords(
    childThreadId,
    ["runtimeRequests", "turnItems"],
    {
      turnItemTypes: ["user_input_request", "approval_request"],
    },
  );
  const request = child.runtimeRequests.find(
    (request) => request.id === requestId && request.status === "pending",
  );
  if (request?.routedTo !== owner.parentThreadId) return;
  if (
    !child.turnItems.some(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.requestId === requestId,
    )
  )
    return;
  const parent = yield* projections.getThreadRecords(
    owner.parentThreadId,
    ["subagents", "runs", "turnItems"],
    {
      turnItemTypes: ["run_interrupt_request"],
    },
  );
  const task = parent.subagents.find((task) => task.id === owner.taskId);
  if (task === undefined) return;
  // A cancelled queue entry never ran, so it must not hide the Stop on the run before it.
  const latestRun = latestExecutedRun(parent.runs);
  // Stop already records this marker, including when there was no live run to interrupt.
  if (
    parent.runs.some((run) => run.status === "queued" && run.queueHeld === true) ||
    parent.turnItems.some(
      (item) => item.runId === latestRun?.id && item.type === "run_interrupt_request",
    )
  )
    return;
  const ownerRun = parent.runs.find((run) => run.id === task.runId);
  // A blocking delegate_task call returns the question itself.
  if (
    task.completionWake === "settled_only" &&
    ownerRun !== undefined &&
    ["preparing", "starting", "running", "waiting"].includes(ownerRun.status)
  )
    return;
  const title = child.thread.title.trim() || "Delegated task";
  const command = {
    type: "message.dispatch",
    commandId: CommandId.make(`server:child-question:${childThreadId}:${requestId}`),
    threadId: owner.parentThreadId,
    messageId: delegatedRequestNoticeId(childThreadId, requestId),
    text: `${title} is waiting on you, its orchestrator (task ${task.id}).\n\n${delegatedRequestDetails(request, child.turnItems)}\n\n${delegatedRequestResponseInstructions(childThreadId, request)}`,
    notification: {
      source: { kind: "delegated_task", taskIds: [task.id] },
      outcome: "updated",
      summary: `${title} ${request.kind === "user_input" ? "has a question for you" : "needs your approval"}`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  } satisfies Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;
  return command;
});
