import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  OrchestrationV2ShellSnapshot,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isOrchestratorOwnedQuestion } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { enabledEnvironmentIds } from "./connections.ts";

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
      Pick<
        OrchestrationV2ThreadShell,
        "id" | "archivedAt" | "pendingRuntimeRequest" | "lineage" | "creationSource"
      >
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
        isOrchestratorOwnedQuestion(thread) ||
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

export function createPendingQuestionsAtom(
  catalog: Atom.Atom<Parameters<typeof enabledEnvironmentIds>[0]>,
  snapshot: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const threads = Atom.family((environmentId: EnvironmentId) =>
    snapshot(environmentId).pipe(Atom.map((value) => value?.threads)),
  );
  let previous: ReadonlyArray<PendingQuestion> = [];
  return Atom.make((get) => {
    const next = collectPendingQuestions(
      Array.from(enabledEnvironmentIds(get(catalog)), (environmentId) => ({
        environmentId,
        threads: get(threads(environmentId)) ?? [],
      })),
    );
    if (
      next.length === previous.length &&
      next.every((question, index) => question.key === previous[index]?.key)
    )
      return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("pending-questions"));
}
