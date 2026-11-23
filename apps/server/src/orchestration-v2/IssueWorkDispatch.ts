import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import type {
  IssueWorkRead,
  OrchestrationV2ServerCommand,
  ThreadId,
  ThreadLinkedIssue,
  OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { sameIssueRepository, isUnmanagedIssueRole } from "../issues/IssueEligibility.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import type { ForkCommandHooks } from "./IssueWorkCommands.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
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

// shortcut: Unlinked managers lock themselves, so concurrent read-only delegations can exceed the cap (#91).
export function threadDispatchLockKey(
  threadId: ThreadId,
  shell: Pick<
    OrchestrationV2AppThread,
    "linkedIssue" | "role" | "lineage" | "creationSource"
  > | null,
) {
  // Registration can change while a command waits; only thread identity determines its key.
  return shell?.linkedIssue !== undefined ||
    (isUnmanagedIssueRole(shell?.role) &&
      shell?.lineage.relationshipToParent === "subagent" &&
      !isProviderNativeSubagentThread(shell))
    ? shell.lineage.rootThreadId
    : threadId;
}

/**
 * The orchestrator's thread lock and the issue reads that precede it. Managed
 * issue threads plan under their root thread's lock.
 */
export const makeIssueWorkDispatch = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  const commandReceipts = yield* CommandReceiptStoreV2;
  const threadExecutor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);
  const issueReads = yield* Effect.serviceOption(IssueService.IssueService);

  const threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"] = {
    activeKeys: threadExecutor.activeKeys,
    withDeletionLock: threadExecutor.withDeletionLock,
    withLock: Effect.fn("withLock")(function* (threadId, effect) {
      const shell = yield* projectionStore.findThread(threadId).pipe(Effect.orDie);
      // Run starts across every managed descendant share the root's planning lock.
      // Whole-thread provider writes use the same key; ordinary provider updates do not plan admissions.
      const key = threadDispatchLockKey(threadId, shell);
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
  const readIssueSnapshots = Effect.fn("readIssueSnapshots")(function* (
    threadId: ThreadId,
    explicit: ReadonlyArray<ThreadLinkedIssue> = [],
    includeQueues = false,
    includeRecipient = false,
  ) {
    if (Option.isNone(issueReads)) return [];
    const selected = new Map(
      explicit.map((issue) => [`${issue.host}:${issue.repositoryId}:${issue.id}`, issue]),
    );
    const shell = yield* projectionStore.getThreadShell(threadId);
    if (
      shell?.linkedIssue !== undefined &&
      !isUnmanagedIssueRole(shell.role) &&
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

  const promoteOtherIssueQueues = Effect.fn("Orchestrator.promoteOtherIssueQueues")(function* <
    E,
    R,
  >(threadId: ThreadId, startNextQueuedRun: (id: ThreadId) => Effect.Effect<void, E, R>) {
    const shell = yield* projectionStore.getThreadShell(threadId);
    if (shell === null || Option.isNone(issueWorkStore)) return;
    const rootThreadId = shell.lineage.rootThreadId;
    if ((yield* issueWorkStore.value.configuration(rootThreadId)) === null) return;
    for (const queuedThreadId of yield* issueWorkStore.value.admissionThreads(rootThreadId)) {
      if (
        queuedThreadId === threadId ||
        !(yield* projectionStore.canStartQueuedRun(queuedThreadId))
      )
        continue;
      const reads = yield* readIssueSnapshots(queuedThreadId);
      yield* threadDispatch.withLock(
        queuedThreadId,
        startNextQueuedRun(queuedThreadId).pipe(Effect.provideService(IssueReadSnapshots, reads)),
      );
    }
  });

  // Receipt replay skips remote eligibility reads; admission still commits in the caller.
  const withAdmissionReads = Effect.fnUntraced(function* <A, E extends OrchestratorV2Error, R>(
    command: OrchestrationV2ServerCommand,
    dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<A, E, R>,
    {
      commandThreadId,
      mapDispatchError,
    }: Pick<ForkCommandHooks, "mapDispatchError"> & {
      readonly commandThreadId: (command: OrchestrationV2ServerCommand) => ThreadId;
    },
  ) {
    const needsReads =
      command.type === "issue.work.start" ||
      command.type === "issue.work.close-out" ||
      command.type === "delegated_task.request" ||
      command.type === "message.dispatch" ||
      (command.type === "thread.pull-request-watch.sync" && command.wake !== undefined) ||
      command.type === "prepared-run.retry" ||
      command.type === "queue.resume" ||
      command.type === "repository.work.continue";
    const receipt = needsReads
      ? yield* commandReceipts.getByCommandId(command.commandId).pipe(mapDispatchError(command))
      : Option.none();
    const issueReads =
      needsReads &&
      (Option.isNone(receipt) ||
        command.type === "queue.resume" ||
        command.type === "repository.work.continue")
        ? yield* readIssueSnapshots(
            commandThreadId(command),
            "issue" in command && command.issue !== undefined ? [command.issue] : [],
            command.type === "repository.work.continue",
            command.type === "issue.work.start",
          ).pipe(mapDispatchError(command))
        : [];
    const dispatchCommand: OrchestrationV2ServerCommand = needsReads
      ? { ...command, issueReads }
      : command;
    return yield* dispatch(dispatchCommand);
  });

  return {
    withAdmissionReads,
    promoteOtherIssueQueues,
    threadExecutor,
    threadDispatch,
    readIssueSnapshots,
  };
});
