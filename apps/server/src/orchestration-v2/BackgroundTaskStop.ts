import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StopBackgroundTaskError,
  type OrchestrationV2StopBackgroundTaskInput,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { pendingBackgroundWorkOfThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * The provider thread whose session runs `taskId` for `threadId`: a roster task on the thread's
 * own provider threads, a shell on its parent's roster tagged with this thread (a Claude native
 * subagent's shells run in the parent's session), or a running Codex background command item.
 * Null when the task is not one of the thread's.
 */
export function findBackgroundTaskProviderThread<
  P extends Pick<OrchestrationV2ProviderThread, "id" | "pendingBackgroundTasks">,
>(input: {
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly own: {
    readonly providerThreads: ReadonlyArray<P>;
    readonly turnItems: ReadonlyArray<
      Pick<OrchestrationV2TurnItem, "id" | "type" | "status" | "nativeItemRef" | "providerThreadId">
    >;
  };
  readonly parentProviderThreads: ReadonlyArray<P>;
}): P | null {
  const rosterOwner =
    input.own.providerThreads.find((providerThread) =>
      (providerThread.pendingBackgroundTasks ?? []).some((task) => task.taskId === input.taskId),
    ) ??
    input.parentProviderThreads.find((providerThread) =>
      pendingBackgroundWorkOfThread(input.threadId, [], providerThread.pendingBackgroundTasks).some(
        (task) => task.taskId === input.taskId,
      ),
    );
  if (rosterOwner !== undefined) return rosterOwner;
  const item = input.own.turnItems.find(
    (candidate) =>
      candidate.type === "command_execution" &&
      isOrchestrationV2WorkActive(candidate.status) &&
      (candidate.nativeItemRef?.nativeId ?? candidate.id) === input.taskId,
  );
  return (
    input.own.providerThreads.find(
      (providerThread) => item !== undefined && providerThread.id === item.providerThreadId,
    ) ?? null
  );
}

/**
 * The provider thread holding one of `threadId`'s background tasks, and the live session running
 * it (null once that session has ended). Null when the task is not one of the thread's.
 */
export const findBackgroundTaskSession = Effect.fn("orchestration.findBackgroundTaskSession")(
  function* (input: { readonly threadId: ThreadId; readonly taskId: string }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const own = yield* threads.getThreadRecords(input.threadId, ["providerThreads", "turnItems"], {
      turnItemTypes: ["command_execution"],
    });
    const parentThreadId = own.thread.lineage.parentThreadId;
    const parent =
      parentThreadId === null
        ? null
        : yield* threads.getThreadRecords(parentThreadId, ["providerThreads"]);
    const providerThread = findBackgroundTaskProviderThread({
      threadId: input.threadId,
      taskId: input.taskId,
      own,
      parentProviderThreads: parent?.providerThreads ?? [],
    });
    if (providerThread === null) return null;
    const runtime =
      providerThread.providerSessionId === null
        ? null
        : Option.getOrNull(
            yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).get(
              providerThread.providerSessionId,
            ),
          );
    return { providerThread, runtime };
  },
);

/** Ends one of a thread's background tasks through the live provider session that runs it. */
export const stopBackgroundTask = Effect.fn("orchestration.stopBackgroundTask")(
  function* (input: OrchestrationV2StopBackgroundTaskInput) {
    const found = yield* findBackgroundTaskSession(input);
    if (found === null) {
      return yield* stopError(input.taskId, "This background task is no longer running.");
    }
    const { providerThread, runtime } = found;
    if (runtime?.stopBackgroundTask === undefined) {
      return yield* stopError(
        input.taskId,
        runtime === null
          ? "The provider session running this task has ended."
          : `Provider '${runtime.driver}' cannot stop a single background task.`,
      );
    }
    yield* runtime.stopBackgroundTask({ providerThread, taskId: input.taskId });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isStopBackgroundTaskError(cause)
          ? cause
          : new OrchestrationV2StopBackgroundTaskError({
              taskId: input.taskId,
              message: "Could not stop the background task.",
              cause,
            }),
      ),
    ),
);

const isStopBackgroundTaskError = Schema.is(OrchestrationV2StopBackgroundTaskError);

const stopError = (taskId: string, message: string) =>
  new OrchestrationV2StopBackgroundTaskError({ taskId, message });
