import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RuntimeRequestId,
  type ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { IdAllocatorV2Allocate } from "@t3tools/provider-core/server/IdAllocator";
import { runtimeRequestNeedsUser } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type Threads<E> = {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, E>;
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"subagents">,
  ) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "subagents">, E>;
};

type Projections = Pick<
  ProjectionStoreV2Shape,
  "getThreadShell" | "getThreadRecords" | "getRuntimeRequest"
>;

/** Only durable app-owned delegation gives a parent authority over a child's requests. */
const delegatedParent = Effect.fn("delegatedParent")(function* <E>(
  threads: Threads<E>,
  childThreadId: ThreadId,
) {
  const child = yield* threads.getThreadShell(childThreadId);
  const parentThreadId = child?.lineage.parentThreadId;
  if (
    child?.lineage.relationshipToParent !== "subagent" ||
    parentThreadId == null ||
    child.forkedFrom?.type !== "node"
  )
    return undefined;
  const parent = yield* threads.getThreadShell(parentThreadId);
  if (parent == null) return undefined;
  const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
  const taskId = child.forkedFrom.nodeId;
  const task = subagents.find(
    (task) =>
      task.origin === "app_owned" && task.id === taskId && task.childThreadId === childThreadId,
  );
  return task === undefined ? undefined : { parentThreadId, taskId: task.id, parent };
});

/** The message that wakes the parent for one child request. */
export const delegatedRequestNoticeId = (childThreadId: ThreadId, requestId: RuntimeRequestId) =>
  MessageId.make(`message:child-question:${childThreadId}:${requestId}`);

/**
 * A child's request goes to its live parent until the request's wake can no longer reach it:
 * held by a restart or Stop, or ended before its turn started. Then the owner answers it.
 */
export const delegatedRequestOwner = Effect.fn("delegatedRequestOwner")(function* (
  projections: Projections,
  childThreadId: ThreadId,
  requestId: RuntimeRequestId,
  inactiveParents: ReadonlySet<ThreadId> = new Set(),
) {
  const owner = yield* delegatedParent(projections, childThreadId);
  if (
    owner === undefined ||
    inactiveParents.has(owner.parentThreadId) ||
    owner.parent.archivedAt !== null ||
    owner.parent.deletedAt !== null
  )
    return undefined;
  const { messages } = yield* projections.getThreadRecords(owner.parentThreadId, ["messages"], {
    messageIds: [delegatedRequestNoticeId(childThreadId, requestId)],
  });
  const wakeRunId = messages[0]?.runId;
  if (wakeRunId != null) {
    const { runs } = yield* projections.getThreadRecords(owner.parentThreadId, ["runs"], {
      runIds: [wakeRunId],
    });
    const wake = runs[0];
    if (
      wake !== undefined &&
      (wake.status === "queued"
        ? wake.queueHeld === true
        : wake.startedAt === null && wake.completedAt !== null)
    )
      return undefined;
  }
  return { parentThreadId: owner.parentThreadId, taskId: owner.taskId };
});

/**
 * Sets `routedTo` on every pending request a write records. Archiving or deleting a parent
 * re-emits its children's routed requests, so the same transaction returns them to the owner.
 */
export const routeDelegatedRequests = (
  projections: Projections,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const inactiveParents = events.filter(
      (event) =>
        (event.type === "thread.archived" ||
          event.type === "thread.deleted" ||
          event.type === "thread.metadata-updated") &&
        (event.payload.archivedAt !== null || event.payload.deletedAt !== null),
    );
    const inactiveParentIds = new Set(inactiveParents.map((event) => event.threadId));
    const fallbacks: OrchestrationV2DomainEvent[] = [];
    for (const parentEvent of inactiveParents) {
      const { subagents } = yield* projections.getThreadRecords(parentEvent.threadId, [
        "subagents",
      ]);
      for (const task of subagents) {
        if (task.origin !== "app_owned" || task.childThreadId === null) continue;
        if ((yield* projections.getThreadShell(task.childThreadId)) === null) continue;
        const { runtimeRequests } = yield* projections.getThreadRecords(task.childThreadId, [
          "runtimeRequests",
        ]);
        for (const request of runtimeRequests) {
          if (
            request.status !== "pending" ||
            request.routedTo !== parentEvent.threadId ||
            events.some(
              (event) =>
                event.type === "runtime-request.updated" &&
                event.threadId === task.childThreadId &&
                event.payload.id === request.id,
            )
          )
            continue;
          fallbacks.push({
            id: EventId.make(`${parentEvent.id}:request-owner:${request.id}`),
            type: "runtime-request.updated",
            threadId: task.childThreadId,
            nodeId: request.nodeId,
            occurredAt: parentEvent.occurredAt,
            payload: request,
          });
        }
      }
    }
    return yield* Effect.forEach(
      [...events, ...fallbacks],
      (event) =>
        event.type === "runtime-request.updated" &&
        event.payload.status === "pending" &&
        runtimeRequestNeedsUser(event.payload.kind)
          ? delegatedRequestOwner(
              projections,
              event.threadId,
              event.payload.id,
              inactiveParentIds,
            ).pipe(
              Effect.map((owner): OrchestrationV2DomainEvent => {
                const { routedTo: _routedTo, ...request } = event.payload;
                return {
                  ...event,
                  payload: {
                    ...request,
                    ...(owner === undefined ? {} : { routedTo: owner.parentThreadId }),
                  },
                };
              }),
            )
          : Effect.succeed(event),
      { concurrency: 1 },
    );
  });

/** Returns a routed request to the owner once its parent can no longer be woken for it. */
export const releaseStrandedDelegatedRequest = Effect.fn("releaseStrandedDelegatedRequest")(
  function* (
    services: {
      readonly projections: Projections;
      readonly eventSink: Pick<EventSinkV2Shape, "write">;
      readonly ids: IdAllocatorV2Allocate;
    },
    childThreadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    const request = yield* services.projections.getRuntimeRequest(childThreadId, requestId);
    if (
      request?.status !== "pending" ||
      request.routedTo === undefined ||
      (yield* delegatedRequestOwner(services.projections, childThreadId, requestId)) !== undefined
    )
      return;
    const commandId = CommandId.make(`server:child-request-owner:${childThreadId}:${requestId}`);
    // routeDelegatedRequests drops the marker from the re-emitted request.
    yield* services.eventSink.write({
      commandId,
      events: [
        {
          id: yield* services.ids.event({ threadId: childThreadId, commandId }),
          type: "runtime-request.updated",
          threadId: childThreadId,
          nodeId: request.nodeId,
          occurredAt: yield* DateTime.now,
          payload: request,
        },
      ],
    });
  },
);

export const isDelegatedDescendant = Effect.fn("isDelegatedDescendant")(function* <E>(
  threads: Threads<E>,
  ancestorThreadId: ThreadId,
  targetThreadId: ThreadId,
) {
  const visited = new Set<ThreadId>();
  let threadId = targetThreadId;
  while (!visited.has(threadId)) {
    visited.add(threadId);
    const owner = yield* delegatedParent(threads, threadId);
    if (owner === undefined) return false;
    if (owner.parentThreadId === ancestorThreadId) return true;
    threadId = owner.parentThreadId;
  }
  return false;
});

/** The parent receives every option and approval detail, not the sidebar's short preview. */
export function delegatedRequestDetails(
  request: OrchestrationV2RuntimeRequest,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const item = items.findLast(
    (item) =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === request.id,
  );
  return item?.type === "user_input_request"
    ? JSON.stringify({ questions: item.questions })
    : item?.type === "approval_request"
      ? JSON.stringify({
          requestKind: item.requestKind,
          prompt: item.prompt,
          appName: item.appName,
          options: item.options,
        })
      : `${request.kind} request ${request.id}`;
}

export function delegatedRequestResponseInstructions(
  childThreadId: ThreadId,
  request: OrchestrationV2RuntimeRequest,
) {
  const response =
    request.kind === "user_input"
      ? 'answers: {questionId: "answer"}'
      : 'decision: "accept" or "decline"';
  return `Answer with t3_pending_request_respond using threadId: ${childThreadId}, requestId: ${request.id}, and ${response}. If you need the owner's decision, ask with your own question tool and relay their answer with t3_pending_request_respond. Child questions and approvals are routed to you; the owner receives no request notification.`;
}
