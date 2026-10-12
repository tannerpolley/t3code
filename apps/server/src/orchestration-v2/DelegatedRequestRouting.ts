import type {
  ThreadId,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type Threads<E> = {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, E>;
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"subagents">,
  ) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "subagents">, E>;
};

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

export const delegatedRequestOwner = Effect.fn("delegatedRequestOwner")(function* <E>(
  threads: Threads<E>,
  childThreadId: ThreadId,
  inactiveParents: ReadonlySet<ThreadId> = new Set(),
) {
  const owner = yield* delegatedParent(threads, childThreadId);
  if (
    owner === undefined ||
    inactiveParents.has(owner.parentThreadId) ||
    owner.parent.archivedAt !== null ||
    owner.parent.deletedAt !== null
  )
    return undefined;
  return { parentThreadId: owner.parentThreadId, taskId: owner.taskId };
});

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
