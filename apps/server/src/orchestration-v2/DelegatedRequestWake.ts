import {
  CommandId,
  EventId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import type * as EventSink from "./EventSink.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import {
  delegatedRequestNoticeId,
  delegatedRequestOwner,
  delegatedRequestDetails,
  delegatedRequestResponseInstructions,
} from "./DelegatedRequestRouting.ts";

export const DelegatedRequestWake = Schema.Struct({
  type: Schema.Literal("delegated-request.wake"),
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
});

const wakeId = (childThreadId: ThreadId, requestId: RuntimeRequestId) =>
  `effect:child-question:${childThreadId}:${requestId}`;

function blockingDelegateReturnsRequest(
  task: Pick<OrchestrationV2Subagent, "completionWake" | "runId"> | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  return (
    task?.completionWake === "settled_only" &&
    runs.some(
      (run) =>
        run.id === task.runId &&
        ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  );
}

/** Queue intake in the request transaction; the listener remains the fast delivery path. */
export const prepareDelegatedRequestWakes = Effect.fn("prepareDelegatedRequestWakes")(function* (
  sql: SqlClient.SqlClient,
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  commandId?: CommandId,
) {
  const stoppedParents = new Set(
    events.flatMap((event) =>
      event.type === "run.updated" &&
      ["failed", "interrupted", "cancelled", "rolled_back"].includes(event.payload.status)
        ? [event.threadId]
        : [],
    ),
  );
  const cancelledWakeIds: string[] = [];
  for (const threadId of stoppedParents)
    cancelledWakeIds.push(
      ...(yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["delegated-request.wake"],
        reason: "The parent run ended before delegated request intake.",
      })),
    );
  // A delivered notice replaces its intake intent in the same transaction.
  for (const event of events) {
    if (
      event.type !== "message.updated" ||
      event.payload.runId === null ||
      !String(event.payload.id).startsWith("message:child-question:")
    )
      continue;
    yield* sql`
      UPDATE orchestration_v2_effect_outbox
      SET status = 'succeeded', last_error = NULL, completed_at = ${DateTime.formatIso(event.occurredAt)},
          updated_at = ${DateTime.formatIso(event.occurredAt)}
      WHERE effect_id = ${String(event.payload.id).replace("message:", "effect:")}
        AND status = 'pending'
    `;
  }
  if (String(commandId).startsWith("command:runtime-reconcile:"))
    return { events, wakeCount: 0, cancelledWakeIds };
  const intents: OrchestrationV2DomainEvent[] = [];
  const seen = new Set<string>();
  let wakeCount = 0;
  for (const event of events) {
    const request =
      event.type === "runtime-request.updated"
        ? event.payload
        : event.type === "turn-item.updated" &&
            (event.payload.type === "user_input_request" ||
              event.payload.type === "approval_request") &&
            event.payload.status === "waiting"
          ? yield* projections.getRuntimeRequest(event.threadId, event.payload.requestId)
          : undefined;
    if (request?.status !== "pending" || request.routedTo === undefined) continue;
    if (
      events.some(
        (candidate) =>
          candidate.type === "runtime-request.updated" &&
          candidate.threadId === event.threadId &&
          candidate.payload.id === request.id &&
          candidate.payload.status !== "pending",
      )
    )
      continue;
    const id = wakeId(event.threadId, request.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const owner = yield* delegatedRequestOwner(projections, event.threadId);
    if (owner === undefined || stoppedParents.has(owner.parentThreadId)) continue;
    const parent = yield* projections.getThreadRecords(owner.parentThreadId, ["subagents", "runs"]);
    const task = parent.subagents.find((task) => task.id === owner.taskId);
    if (blockingDelegateReturnsRequest(task, parent.runs)) continue;
    const { messages } = yield* projections.getThreadRecords(owner.parentThreadId, ["messages"], {
      messageIds: [delegatedRequestNoticeId(event.threadId, request.id)],
    });
    if (messages.some((message) => message.runId !== null)) continue;
    const prior = yield* outbox.get(id);
    if (prior._tag === "Some") continue;
    yield* outbox.enqueue([
      {
        id,
        commandId: CommandId.make(`server:child-question:${event.threadId}:${request.id}`),
        threadId: owner.parentThreadId,
        request: {
          type: "delegated-request.wake",
          childThreadId: event.threadId,
          requestId: request.id,
        },
      },
    ]);
    wakeCount += 1;
    // This is queued agent work, not a user message until its run is admitted.
    intents.push({
      id: EventId.make(`event:child-question-intake:${event.threadId}:${request.id}`),
      type: "message.updated",
      threadId: owner.parentThreadId,
      occurredAt: event.occurredAt,
      payload: {
        id: delegatedRequestNoticeId(event.threadId, request.id),
        threadId: owner.parentThreadId,
        runId: null,
        nodeId: null,
        role: "system",
        text: "A delegated request is queued for its orchestrator.",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "server",
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      },
    });
  }
  // Commit parent intake before publishing any child event.
  return { events: [...intents, ...events], wakeCount, cancelledWakeIds };
});

/** Pending outbox intake is real queued work, until delivery, Stop, failure or recovery. */
export const pendingDelegatedRequestWake = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId | Statement.Fragment,
) => sql`
  EXISTS (
    SELECT 1 FROM orchestration_v2_effect_outbox wake
    WHERE wake.thread_id = ${threadId} AND wake.effect_type = 'delegated-request.wake'
      AND wake.status IN ('pending', 'running')
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runtime_requests request
        WHERE request.thread_id = json_extract(wake.payload_json, '$.childThreadId')
          AND request.runtime_request_id = json_extract(wake.payload_json, '$.requestId')
          AND request.status = 'pending'
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_runs held
    WHERE held.thread_id = ${threadId} AND held.status = 'queued'
      AND json_extract(held.payload_json, '$.queueHeld') = 1
  )
`;

export function delegatedWakeShellStatus(
  shell: Pick<
    OrchestrationV2ThreadShell,
    "status" | "activeRunId" | "activityRunStatus" | "archivedAt" | "deletedAt"
  >,
  pending: boolean,
): OrchestrationV2ThreadShell["status"] {
  return pending &&
    shell.activeRunId === null &&
    shell.activityRunStatus == null &&
    shell.archivedAt === null &&
    shell.deletedAt === null
    ? "queued"
    : shell.status;
}

export function delegatedWakeCancellation(
  commandType: string,
  prior?: {
    readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  },
) {
  return ["thread.stop", "run.interrupt", "thread.archive", "thread.delete"].includes(commandType)
    ? {
        effectTypes: [...(prior?.effectTypes ?? []), "delegated-request.wake" as const],
        reason: prior?.reason ?? "The parent stopped before delegated request intake.",
      }
    : prior;
}

/** Publish the intake notice after outbox settlement so shell subscribers see failed/no-op wakes. */
export const refreshDelegatedRequestWake = Effect.fn("refreshDelegatedRequestWake")(function* <E>(
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  write: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => Effect.Effect<unknown, E>,
  effect: EffectOutbox.OrchestrationEffectV2,
) {
  if (effect.request.type !== "delegated-request.wake") return;
  const messageId = delegatedRequestNoticeId(
    effect.request.childThreadId,
    effect.request.requestId,
  );
  const { messages } = yield* projections.getThreadRecords(effect.threadId, ["messages"], {
    messageIds: [messageId],
  });
  const notice = messages[0];
  if (notice === undefined || notice.runId !== null) return;
  const now = yield* DateTime.now;
  yield* write([
    {
      id: EventId.make(`event:child-question-settled:${effect.id}:${effect.attemptCount}`),
      type: "message.updated",
      threadId: effect.threadId,
      occurredAt: now,
      payload: { ...notice, updatedAt: now },
    },
  ]);
});

export const delegatedRequestWakeCommand = Effect.fn("delegatedRequestWakeCommand")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
  outbox: EffectOutbox.EffectOutboxV2["Service"],
) {
  const intent = yield* outbox.get(wakeId(childThreadId, requestId));
  if (
    intent._tag === "Some" &&
    (intent.value.status === "cancelled" ||
      intent.value.status === "failed" ||
      intent.value.status === "succeeded")
  )
    return { state: "gone" as const };
  const owner = yield* delegatedRequestOwner(projections, childThreadId);
  if (owner === undefined) return { state: "gone" as const };
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
  if (request?.routedTo !== owner.parentThreadId) return { state: "gone" as const };
  if (
    !child.turnItems.some(
      (item) =>
        (item.type === "user_input_request" || item.type === "approval_request") &&
        item.requestId === requestId,
    )
  )
    return { state: "waiting" as const };
  const parent = yield* projections.getThreadRecords(owner.parentThreadId, ["subagents", "runs"]);
  const task = parent.subagents.find((task) => task.id === owner.taskId);
  if (task === undefined) return { state: "gone" as const };
  if (blockingDelegateReturnsRequest(task, parent.runs)) return { state: "gone" as const };
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
  return { state: "ready" as const, command };
});

export const deliverDelegatedRequestWake = Effect.fn("deliverDelegatedRequestWake")(function* <E>(
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  sink: EventSink.EventSinkV2["Service"],
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  dispatch: (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
  ) => Effect.Effect<unknown, E>,
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
) {
  for (;;) {
    const afterSequence = yield* sink.latestSequence();
    const wake = yield* delegatedRequestWakeCommand(projections, childThreadId, requestId, outbox);
    if (wake.state === "gone") return;
    if (wake.state === "ready") {
      yield* dispatch(wake.command);
      return;
    }
    // Adapters may commit the request before its full prompt. Await a persisted milestone.
    yield* sink.stream({ afterSequence }).pipe(
      Stream.filter(
        ({ event }) =>
          event.threadId === childThreadId &&
          ((event.type === "runtime-request.updated" && event.payload.id === requestId) ||
            (event.type === "turn-item.updated" &&
              (event.payload.type === "user_input_request" ||
                event.payload.type === "approval_request") &&
              event.payload.requestId === requestId)),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  }
});
