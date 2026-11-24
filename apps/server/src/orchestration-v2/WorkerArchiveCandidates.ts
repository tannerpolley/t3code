import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "./ProjectionStore.ts";
import { isIdleWorker, workerCompletionIsCurrent } from "./ThreadSettlementService.ts";

export const ARCHIVE_REMINDER_GRACE_MS = 5 * 60 * 1000;

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
) {
  const finished = new Map<ThreadId, ProjectionStore.ProjectionSettlementCandidate>();
  let afterThreadId: ThreadId | undefined;
  do {
    const workers = yield* projections.getSettlementCandidates(undefined, {
      ...(afterThreadId === undefined ? {} : { afterThreadId }),
    });
    for (const worker of workers) {
      if (finishedWorkerAt(worker, now) !== null) finished.set(worker.id, worker);
    }
    afterThreadId = workers.at(-1)?.id;
  } while (afterThreadId !== undefined);

  return finished;
});

export const reminderRecipient = Effect.fn("WorkerArchiveCandidates.reminderRecipient")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  parentId: ThreadId | null,
  parents: Map<ThreadId, ThreadId | null>,
  finished: ReadonlyMap<ThreadId, ProjectionStore.ProjectionSettlementCandidate>,
) {
  const visited = new Set<ThreadId>();
  while (parentId !== null && !visited.has(parentId)) {
    if (parents.has(parentId)) {
      parentId = parents.get(parentId) ?? null;
      break;
    }
    visited.add(parentId);
    const parent = yield* projections
      .getThread(parentId)
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    if (parent === null) {
      parentId = null;
      break;
    }
    // Waking a finished parent would start a new turn and invalidate its own archive.
    if (parent.archivedAt === null && parent.deletedAt === null && !finished.has(parentId)) {
      break;
    }
    parentId = parent.lineage.parentThreadId;
  }
  for (const id of visited) parents.set(id, parentId);
  return parentId;
});
