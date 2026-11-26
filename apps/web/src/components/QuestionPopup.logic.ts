import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface PendingQuestion {
  readonly key: string;
  readonly thread: ScopedThreadRef;
  readonly requestId: RuntimeRequestId;
  readonly createdAt: number;
}

export function collectPendingQuestions(
  environments: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly threads: ReadonlyArray<
      Pick<OrchestrationV2ThreadShell, "id" | "archivedAt" | "pendingRuntimeRequest">
    >;
  }>,
): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  for (const { environmentId, threads } of environments) {
    for (const thread of threads) {
      const request = thread.pendingRuntimeRequest;
      if (
        thread.archivedAt !== null ||
        request?.kind !== "user_input" ||
        request.userOnly === true
      ) {
        continue;
      }
      questions.push({
        key: JSON.stringify([environmentId, thread.id, request.id]),
        thread: { environmentId, threadId: thread.id },
        requestId: request.id,
        createdAt: DateTime.toEpochMillis(request.createdAt),
      });
    }
  }
  return questions.sort(
    (left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
  );
}

export function visibleQuestionQueue(
  questions: ReadonlyArray<PendingQuestion>,
  deferred: ReadonlySet<string>,
  shownThread: ScopedThreadRef | null,
  shownSideThread: ScopedThreadRef | null,
): PendingQuestion[] {
  return questions.filter(
    ({ key, thread }) =>
      !deferred.has(key) &&
      ![shownThread, shownSideThread].some(
        (shown) =>
          shown?.environmentId === thread.environmentId && shown.threadId === thread.threadId,
      ),
  );
}

export function deferQuestions(
  deferred: ReadonlySet<string>,
  queue: ReadonlyArray<PendingQuestion>,
  action: "later" | "close",
): ReadonlySet<string> {
  const visible = action === "later" ? queue.slice(0, 1) : queue;
  return new Set([...deferred, ...visible.map(({ key }) => key)]);
}
