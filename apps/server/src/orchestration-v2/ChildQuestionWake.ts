import { CommandId, MessageId, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { pendingUserRequests } from "./SubagentProjection.ts";
import { isActiveRun, ThreadManagementService } from "./ThreadManagementService.ts";

/**
 * Tells the parent of an app-owned delegated task, once per request, that the child is waiting
 * on the user. A child blocked on a question keeps its run open, so the completion wake never
 * fires. The notice is a queued server notification on the parent, the same message a
 * background-task wake dispatches: it starts a parent turn when the parent is idle and waits
 * behind an active one. The command id is keyed by the request, so a replayed event or a
 * restart finds the earlier receipt instead of posting again.
 */
export const makeNotifyParent = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("ChildQuestionWake.notifyParent")(function* (
    childThreadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    if (!(yield* settings.getSettings).wakeParentOnChildQuestion) return;
    const child = yield* threads.getThreadRecords(childThreadId, ["runtimeRequests", "turnItems"], {
      turnItemTypes: ["user_input_request", "approval_request"],
    });
    const { lineage, forkedFrom } = child.thread;
    if (
      lineage.relationshipToParent !== "subagent" ||
      lineage.parentThreadId === null ||
      forkedFrom?.type !== "node"
    ) {
      return;
    }
    const request = pendingUserRequests(child).find((candidate) => candidate.id === requestId);
    if (request === undefined) return;
    const parent = yield* threads.getThreadRecords(lineage.parentThreadId, ["subagents", "runs"]);
    const task = parent.subagents.find(
      (candidate) =>
        candidate.id === forkedFrom.nodeId &&
        candidate.origin === "app_owned" &&
        candidate.childThreadId === childThreadId,
    );
    if (
      task === undefined ||
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null
    ) {
      return;
    }
    // A blocking delegate_task wait still owns this task and returns the question itself; a
    // queued notice would only repeat it after the parent's turn ends.
    const ownerRun = parent.runs.find((run) => run.id === task.runId);
    if (task.completionWake === "settled_only" && ownerRun !== undefined && isActiveRun(ownerRun)) {
      return;
    }
    const title = child.thread.title.trim() || "Delegated task";
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:child-question:${childThreadId}:${requestId}`),
      threadId: parent.thread.id,
      messageId: MessageId.make(`message:child-question:${childThreadId}:${requestId}`),
      text: `${title} is waiting on the user: ${request.summary}. Relay it to the user or answer it if you can (task ${task.id}, child thread ${childThreadId}, request ${requestId}).`,
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id] },
        outcome: "updated",
        summary: `${title} ${request.kind === "input" ? "has a question for you" : "needs your approval"}`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });
});

/**
 * Startup recovery expires every live request, so the questions still pending afterwards are
 * the ones answered by message. Their notice may have been lost if the server stopped between
 * persisting the question and notifying the parent, so this re-offers it once recovery is done;
 * the keyed command id skips parents that were already told.
 */
export class ChildQuestionWake extends Context.Service<
  ChildQuestionWake,
  { readonly notifyAfterRecovery: Effect.Effect<void> }
>()("t3/orchestration-v2/ChildQuestionWake") {}

// Request items land after their runtime request, so the item event is the one that carries
// the question text. Only live events matter here: questions from before startup go through
// notifyAfterRecovery.
export const layer = Layer.effect(
  ChildQuestionWake,
  Effect.gen(function* () {
    const notifyParent = yield* makeNotifyParent;
    const threads = yield* ThreadManagementService;
    const projections = yield* ProjectionStoreV2;
    const eventSink = yield* EventSinkV2;
    const notifyLogged = (threadId: ThreadId, requestId: RuntimeRequestId) =>
      notifyParent(threadId, requestId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.child-question-wake.failed", {
            threadId,
            requestId,
            cause,
          }),
        ),
      );
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* eventSink.stream({ afterSequence, eventType: "turn-item.updated" }).pipe(
      Stream.runForEach((stored) => {
        const item = stored.event.type === "turn-item.updated" ? stored.event.payload : undefined;
        if (
          (item?.type !== "user_input_request" && item?.type !== "approval_request") ||
          item.status !== "waiting"
        ) {
          return Effect.void;
        }
        return notifyLogged(stored.event.threadId, item.requestId);
      }),
      Effect.forkScoped,
    );
    return ChildQuestionWake.of({
      // Runtime recovery's thread set already includes every thread with a pending request.
      notifyAfterRecovery: projections.getRecoveryThreadIds("runtime").pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              threads.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
                Effect.flatMap((thread) =>
                  Effect.forEach(
                    thread.runtimeRequests.filter((request) => request.status === "pending"),
                    (request) => notifyLogged(threadId, request.id),
                    { discard: true },
                  ),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.child-question-wake.recovery-failed", {
                    threadId,
                    cause,
                  }),
                ),
              ),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.child-question-wake.recovery-failed", { cause }),
        ),
      ),
    });
  }),
);
