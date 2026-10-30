import {
  type ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  OrchestratorV2Shape,
  OrchestratorV2Error,
  OrchestratorV2DispatchResult,
} from "./Orchestrator.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import {
  delegatedRequestDetails,
  delegatedRequestResponseInstructions,
} from "./DelegatedRequestRouting.ts";

/** Load the routed prompt before the parent lock; admission is rechecked at dispatch. */
const prepareDelegatedRequestWake = Effect.fn("prepareDelegatedRequestWake")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  task: OrchestrationV2Subagent,
  request: OrchestrationV2RuntimeRequest,
  command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
) {
  if (task.childThreadId === null) return;
  const child = yield* projections.getThreadRecords(task.childThreadId, ["turnItems"], {
    turnItemTypes: ["user_input_request", "approval_request"],
  });
  if (
    !child.turnItems.some(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.requestId === request.id,
    )
  ) {
    return request.kind === "user_input" ? command : undefined;
  }
  const title = child.thread.title.trim() || "Delegated task";
  return {
    ...command,
    text: `${title} is waiting on you, its orchestrator (task ${task.id}).\n\n${delegatedRequestDetails(request, child.turnItems)}\n\n${delegatedRequestResponseInstructions(task.childThreadId, request)}`,
  };
});

/** Recheck routed wake admission while holding the parent's dispatch lock. */
export const canWakeDelegatedRequest = Effect.fn("canWakeDelegatedRequest")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  task: OrchestrationV2Subagent,
  request: OrchestrationV2RuntimeRequest,
) {
  if (task.childThreadId === null || request.routedTo !== task.threadId) return false;
  const current = yield* projections.getRuntimeRequest(task.childThreadId, request.id);
  if (current?.status !== "pending") return false;
  const parent = yield* projections.getThreadRecords(
    task.threadId,
    ["runs", "turnItems", "subagents"],
    {
      turnItemTypes: ["run_interrupt_request"],
    },
  );
  const currentTask = parent.subagents.find((candidate) => candidate.id === task.id);
  if (
    currentTask === undefined ||
    currentTask.completionDelivery?.state === "disposed" ||
    ["completed", "failed", "cancelled", "interrupted"].includes(currentTask.status)
  )
    return false;
  const latestRun = latestExecutedRun(parent.runs);
  if (
    parent.runs.some((run) => run.status === "queued" && run.queueHeld === true) ||
    parent.turnItems.some(
      (item) => item.runId === latestRun?.id && item.type === "run_interrupt_request",
    )
  )
    return false;
  const ownerRun = parent.runs.find((run) => run.id === currentTask.runId);
  return !(
    currentTask.completionWake === "settled_only" &&
    current.responseCapability.type !== "message" &&
    ownerRun !== undefined &&
    ["preparing", "starting", "running", "waiting"].includes(ownerRun.status)
  );
});

/** A native approval's prompt can arrive after its request. Retry when the prompt is persisted. */
export const delegatedRequestPromptEvent = Effect.fn("delegatedRequestPromptEvent")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  event: import("@t3tools/contracts").OrchestrationV2DomainEvent,
) {
  if (
    event.type !== "turn-item.updated" ||
    (event.payload.type !== "approval_request" && event.payload.type !== "user_input_request") ||
    event.payload.status !== "waiting"
  )
    return;
  const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.requestId);
  if (request?.status !== "pending" || request.routedTo === undefined) return;
  return { ...event, type: "runtime-request.updated", payload: request } as const;
});

type WakeCommand = Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;

export function makeDelegatedRequestWakeDispatcher(dependencies: {
  readonly getReceipt: (
    command: WakeCommand,
  ) => Effect.Effect<Option.Option<unknown>, OrchestratorV2Error>;
  readonly readIssueSnapshots: (
    command: WakeCommand,
  ) => Effect.Effect<NonNullable<WakeCommand["issueReads"]>, OrchestratorV2Error>;
  readonly withLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly canWake: (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) => Effect.Effect<boolean, OrchestratorV2Error>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
}) {
  // Issue reads can wait on GitHub, so read them before taking the parent thread lock.
  return Effect.fn("Orchestrator.dispatchDelegatedRequestWake")(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
    command: WakeCommand,
  ) {
    const receipt = yield* dependencies.getReceipt(command);
    const issueReads = Option.isNone(receipt)
      ? yield* dependencies.readIssueSnapshots(command)
      : [];
    const dispatchCommand: OrchestrationV2ServerCommand = { ...command, issueReads };
    yield* dependencies.withLock(
      command.threadId,
      Effect.gen(function* () {
        const allowed = yield* dependencies.canWake(task, request);
        if (!allowed) return;
        yield* dependencies.dispatch(dispatchCommand);
      }),
    );
  });
}

// The question reactor owns the enclosing wake span.
export const wakeRoutedDelegatedRequest = Effect.fnUntraced(function* (
  engine: Pick<OrchestratorV2Shape, "dispatchDelegatedRequestWake">,
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  task: OrchestrationV2Subagent,
  request: OrchestrationV2RuntimeRequest,
  command: WakeCommand,
) {
  if (request.routedTo === undefined) return false;
  const wake = yield* prepareDelegatedRequestWake(projections, task, request, command);
  if (wake !== undefined) yield* engine.dispatchDelegatedRequestWake(task, request, wake);
  return true;
});
