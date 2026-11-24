import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";
import { isIdleWorker, workerCompletionIsCurrent } from "./ThreadSettlementService.ts";

export function isLocalDelegatedWorker(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.delegatedFrom == null &&
    thread.createdBy !== "user" &&
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null &&
    thread.lineage.sideChat !== true &&
    !isProviderNativeSubagentThread(thread)
  );
}

export function finishedWorkerAt(
  worker: ProjectionStore.ProjectionSettlementCandidate,
  now: DateTime.Utc,
): number | null {
  const completedAt = worker.workerResult?.completedAt;
  return completedAt !== undefined &&
    isIdleWorker(worker, now) &&
    workerCompletionIsCurrent(worker, completedAt)
    ? completedAt
    : null;
}

export const finishedWorkers = Effect.fn("WorkerArchiveCandidates.finishedWorkers")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  now: DateTime.Utc,
  rootThreadId?: ThreadId,
) {
  const finished = new Map<ThreadId, ProjectionStore.ProjectionSettlementCandidate>();
  let afterThreadId: ThreadId | undefined;
  do {
    const workers = yield* projections.getSettlementCandidates(undefined, {
      ...(rootThreadId === undefined ? {} : { rootThreadId }),
      ...(afterThreadId === undefined ? {} : { afterThreadId }),
    });
    for (const worker of workers) {
      if (finishedWorkerAt(worker, now) !== null) finished.set(worker.id, worker);
    }
    afterThreadId = workers.at(-1)?.id;
  } while (afterThreadId !== undefined);

  return finished;
});
