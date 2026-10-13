import {
  runtimeRequestIsOwnerVisible,
  type RoutedRequestParent,
} from "@t3tools/shared/delegatedRequestVisibility";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface PendingQuestion {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly createdAt: number;
}

/**
 * Owner-facing questions on unarchived threads, oldest first.
 * Answered, dismissed and cancelled questions leave
 * the shell, so they leave this list with it.
 */
export function collectPendingQuestions(
  environments: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly threads: ReadonlyArray<
      Pick<OrchestrationV2ThreadShell, "id" | "pendingRuntimeRequest"> & RoutedRequestParent
    >;
  }>,
): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  for (const { environmentId, threads } of environments) {
    const index = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      const request = thread.pendingRuntimeRequest;
      if (
        request?.kind !== "user_input" ||
        !runtimeRequestIsOwnerVisible(
          request,
          request.routedTo === undefined ? undefined : index.get(request.routedTo),
        ) ||
        thread.archivedAt !== null
      )
        continue;
      questions.push({
        key: JSON.stringify([environmentId, thread.id, request.id]),
        environmentId,
        threadId: thread.id,
        requestId: request.id,
        createdAt: DateTime.toEpochMillis(request.createdAt),
      });
    }
  }
  return questions.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
  );
}

/**
 * The questions the popup shows: not put off with Later or Close, and not in
 * the open thread, whose composer already shows its question.
 */
export function visibleQuestionQueue(
  questions: ReadonlyArray<PendingQuestion>,
  deferredKeys: ReadonlySet<string>,
  activeThread: {
    readonly environmentId?: string | undefined;
    readonly threadId?: string | undefined;
  },
): PendingQuestion[] {
  return questions.filter(
    (question) =>
      !deferredKeys.has(question.key) &&
      !(
        question.environmentId === activeThread.environmentId &&
        question.threadId === activeThread.threadId
      ),
  );
}
