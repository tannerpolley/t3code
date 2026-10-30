import {
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  type pendingUserRequests,
  runtimeRequestNeedsUser,
} from "@t3tools/provider-core/server/subagentProjection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type Threads<E> = {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<OrchestrationV2ThreadShell, "lineage" | "forkedFrom" | "archivedAt" | "deletedAt"> | null,
    E
  >;
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

/** Only a live app-owned parent receives newly created requests. */
export const delegatedRequestOwner = Effect.fn("delegatedRequestOwner")(function* <E>(
  projections: Threads<E>,
  childThreadId: ThreadId,
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
  return { parentThreadId: owner.parentThreadId, taskId: owner.taskId };
});

/** Records the parent once. Visibility follows its shell, without rewriting the request. */
export const routeDelegatedRequests = Effect.fn("routeDelegatedRequests")(function* (
  projections: Projections,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const inactiveParents = events.filter(
    (event) =>
      (event.type === "thread.archived" ||
        event.type === "thread.deleted" ||
        event.type === "thread.metadata-updated") &&
      (event.payload.archivedAt !== null || event.payload.deletedAt !== null),
  );
  const inactiveParentIds = new Set(inactiveParents.map((event) => event.threadId));
  const createdThreads = new Map(
    events.flatMap((event) =>
      event.type === "thread.created" ? [[event.threadId, event.payload] as const] : [],
    ),
  );
  const batchThreads = {
    ...projections,
    getThreadShell: (threadId: ThreadId) => {
      const created = createdThreads.get(threadId);
      return created === undefined ? projections.getThreadShell(threadId) : Effect.succeed(created);
    },
  };
  return yield* Effect.forEach(
    events,
    (event) =>
      Effect.gen(function* () {
        if (
          event.type !== "runtime-request.updated" ||
          event.payload.status !== "pending" ||
          !runtimeRequestNeedsUser(event.payload.kind)
        )
          return event;
        const existing = createdThreads.has(event.threadId)
          ? null
          : yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
        const routedTo =
          existing == null
            ? (yield* delegatedRequestOwner(batchThreads, event.threadId, inactiveParentIds))
                ?.parentThreadId
            : existing.routedTo;
        return {
          ...event,
          payload: { ...event.payload, ...(routedTo === undefined ? {} : { routedTo }) },
        };
      }),
    { concurrency: 1 },
  );
});

const isDelegatedDescendant = Effect.fn("isDelegatedDescendant")(function* <E>(
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
  return `Answer with t3_pending_request action="respond" using threadId: ${childThreadId}, requestId: ${request.id}, and ${response}. If you need the owner's decision, ask with your own question tool and relay their answer with t3_pending_request action="respond". Child questions and approvals are routed to you while you are active. Requests left unanswered become visible to the owner when you stop.`;
}

export class ThreadManagementPendingRequestError extends Schema.TaggedError<ThreadManagementPendingRequestError>()(
  "ThreadManagementPendingRequestError",
  {
    reason: Schema.Literals(["not-found", "invalid-response", "outside-descendants"]),
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  },
) {
  override get message() {
    return this.reason === "outside-descendants"
      ? "An orchestrator may answer or approve only requests in its own delegated descendant subtree."
      : this.reason === "not-found"
        ? "The pending question or approval was not found."
        : "Pass answers for a question, or an accept/decline decision for an approval.";
  }
}

export const delegatedRequestResponse = Effect.fn("delegatedRequestResponse")(function* <E>(
  orchestrator: Threads<E>,
  input: Parameters<ThreadManagementServiceShape["respondToPendingRequest"]>[0],
  runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
) {
  const request = runtimeRequests.find(
    (request) => request.id === input.requestId && request.status === "pending",
  );
  const fail = (reason: ThreadManagementPendingRequestError["reason"]) =>
    new ThreadManagementPendingRequestError({ ...input, reason });
  if (
    request === undefined ||
    request.kind === "auth_refresh" ||
    request.kind === "dynamic_tool_call"
  )
    return yield* fail("not-found");
  const question = request.kind === "user_input";
  if (
    question
      ? input.answers === undefined || input.decision !== undefined
      : input.decision === undefined || input.answers !== undefined
  )
    return yield* fail("invalid-response");
  const descendant =
    input.callerThreadId !== undefined &&
    input.callerThreadId !== input.threadId &&
    (yield* isDelegatedDescendant(orchestrator, input.callerThreadId, input.threadId));
  if (
    (!question && !descendant) ||
    (input.callerThreadId !== undefined && input.callerThreadId !== input.threadId && !descendant)
  )
    return yield* fail("outside-descendants");
  return {
    type: "runtime-request.respond" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    requestId: input.requestId,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(descendant ? { respondedBy: "orchestrator" as const } : {}),
  };
});

export function delegatedRequestWaitingOnUser(
  childThreadId: ThreadId,
  runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
  requestItems: ReadonlyArray<OrchestrationV2TurnItem>,
  waitingRequests: ReturnType<typeof pendingUserRequests>,
) {
  return {
    kind: waitingRequests[0]!.kind,
    requestIds: waitingRequests.map((request) => request.id),
    ...(runtimeRequests.some(
      (request) => request.id === waitingRequests[0]?.id && request.routedTo !== undefined,
    )
      ? { waitingOn: "orchestrator" as const }
      : {}),
    preview: runtimeRequests
      .filter((request) => waitingRequests.some((waiting) => waiting.id === request.id))
      .map((request) =>
        request.routedTo === undefined
          ? waitingRequests.find((waiting) => waiting.id === request.id)!.summary
          : `${delegatedRequestDetails(request, requestItems)}\n${delegatedRequestResponseInstructions(childThreadId, request)}`,
      )
      .join("\n\n"),
  };
}
