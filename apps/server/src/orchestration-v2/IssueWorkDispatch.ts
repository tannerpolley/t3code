import type { IssueWorkRead, ThreadId, ThreadLinkedIssue } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { sameIssueRepository } from "../issues/IssueEligibility.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

/** Issue relationship snapshots read before the planning lock, for the planner to admit work. */
export class IssueReadSnapshots extends Context.Reference<ReadonlyArray<IssueWorkRead>>(
  "t3/issues/PlanningReads",
  {
    defaultValue: (): ReadonlyArray<IssueWorkRead> => [],
  },
) {}

/** Dispatch lock keys the current fiber already holds. */
class HeldDispatchLocks extends Context.Reference<ReadonlySet<ThreadId>>(
  "t3/issues/HeldDispatchLocks",
  {
    defaultValue: (): ReadonlySet<ThreadId> => new Set(),
  },
) {}

/**
 * The orchestrator's thread lock and the issue reads that precede it. Managed
 * issue threads plan under their root thread's lock.
 */
export const makeIssueWorkDispatch = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  const threadExecutor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const issueReads = yield* Effect.serviceOption(IssueService.IssueService);

  const threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"] = {
    activeKeys: threadExecutor.activeKeys,
    withLock: (threadId, effect) =>
      Effect.gen(function* () {
        const shell = yield* projectionStore.getThreadShell(threadId).pipe(Effect.orDie);
        // Run starts across every managed descendant share the root's planning lock.
        // Provider updates do not create admissions, and retain their ordinary thread lock.
        const key = shell?.linkedIssue === undefined ? threadId : shell.lineage.rootThreadId;
        // A child's dispatch can nest inside its parent's lock, and both may resolve to
        // the root. The lock is not reentrant, so a held key is not taken again.
        const held = yield* HeldDispatchLocks;
        if (held.has(key)) return yield* effect;
        return yield* threadExecutor.withLock(
          key,
          effect.pipe(Effect.provideService(HeldDispatchLocks, new Set([...held, key]))),
        );
      }),
  };

  // Relationship I/O precedes the planning lock. A missing/failed snapshot
  // cannot admit work; ownership, lineage, suspension and capacity are checked
  // again from committed local state while planning.
  const readIssueSnapshots = (
    threadId: ThreadId,
    explicit: ReadonlyArray<ThreadLinkedIssue> = [],
    includeQueues = false,
    includeRecipient = false,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(issueReads)) return [];
      const selected = new Map(
        explicit.map((issue) => [`${issue.host}:${issue.repositoryId}:${issue.id}`, issue]),
      );
      const shell = yield* projectionStore.getThreadShell(threadId);
      if (
        shell?.linkedIssue !== undefined &&
        shell.activeRunId === null &&
        Option.isSome(issueWorkStore) &&
        (yield* issueWorkStore.value.canAdmit(shell.linkedIssue, threadId))
      )
        selected.set(
          `${shell.linkedIssue.host}:${shell.linkedIssue.repositoryId}:${shell.linkedIssue.id}`,
          shell.linkedIssue,
        );
      if (includeQueues && Option.isSome(issueWorkStore)) {
        const rootId = shell?.lineage.rootThreadId ?? threadId;
        for (const workerId of yield* issueWorkStore.value.workerThreads(rootId)) {
          if (!(yield* projectionStore.canStartQueuedRun(workerId))) continue;
          const worker = yield* projectionStore.getThreadShell(workerId);
          if (
            worker?.linkedIssue !== undefined &&
            !(yield* issueWorkStore.value.canAdmit(worker.linkedIssue, workerId))
          )
            continue;
          if (worker?.linkedIssue !== undefined)
            selected.set(
              `${worker.linkedIssue.host}:${worker.linkedIssue.repositoryId}:${worker.linkedIssue.id}`,
              worker.linkedIssue,
            );
        }
      }
      const reads: IssueWorkRead[] = [];
      for (const issue of selected.values()) {
        const read = yield* issueReads.value.workRead(issue).pipe(Effect.option);
        if (
          Option.isSome(read) &&
          sameIssueRepository(read.value.issue, issue) &&
          read.value.issue.id === issue.id
        ) {
          reads.push(read.value);
          if (
            includeRecipient &&
            read.value.parent !== null &&
            sameIssueRepository(read.value.parent, issue) &&
            Option.isSome(issueWorkStore)
          ) {
            const ownerId = yield* issueWorkStore.value.issueOwner(read.value.parent);
            const owner = ownerId === null ? null : yield* projectionStore.getThreadShell(ownerId);
            if (
              owner?.linkedIssue !== undefined &&
              owner.activeRunId === null &&
              (yield* issueWorkStore.value.canAdmit(owner.linkedIssue, owner.id))
            )
              selected.set(
                `${owner.linkedIssue.host}:${owner.linkedIssue.repositoryId}:${owner.linkedIssue.id}`,
                owner.linkedIssue,
              );
          }
        }
      }
      return reads;
    });

  return { threadExecutor, threadDispatch, readIssueSnapshots };
});
