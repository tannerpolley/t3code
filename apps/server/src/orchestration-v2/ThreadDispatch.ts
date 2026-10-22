import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

/** Dispatch lock keys the current fiber already holds. */
class HeldDispatchLocks extends Context.Reference<ReadonlySet<ThreadId>>(
  "t3/issues/HeldDispatchLocks",
  {
    defaultValue: (): ReadonlySet<ThreadId> => new Set(),
  },
) {}

/** Repository descendants share admission and whole-thread writes under the root lock. */
function threadDispatchLockKey(
  threadId: ThreadId,
  shell: Pick<OrchestrationV2ThreadShell, "lineage" | "linkedIssue"> | null,
  rootIsRepositoryOrchestrator: boolean,
) {
  // ponytail: a command already in flight at assignment ran under its old key.
  return shell !== null && (shell.linkedIssue !== undefined || rootIsRepositoryOrchestrator)
    ? shell.lineage.rootThreadId
    : threadId;
}

/** Shared by command dispatch and direct projection writers, including nested provider events. */
export const makeThreadDispatch = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  const threadExecutor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const issueWorkStore = yield* Effect.serviceOption(IssueWorkStore.IssueWorkStore);

  const getThreadDispatchLockKey = Effect.fn("ThreadDispatch.getThreadDispatchLockKey")(function* (
    threadId: ThreadId,
    initialShell?: Pick<OrchestrationV2ThreadShell, "lineage" | "linkedIssue">,
  ) {
    // Native child creation has no stored shell yet; its event supplies the initial lineage.
    const shell =
      (yield* projectionStore.getThreadShell(threadId).pipe(Effect.orDie)) ?? initialShell ?? null;
    const registered = Option.isSome(issueWorkStore)
      ? yield* issueWorkStore.value
          .isRepositoryOrchestrator(shell?.lineage.rootThreadId ?? threadId)
          .pipe(Effect.orDie)
      : false;
    return threadDispatchLockKey(threadId, shell, registered);
  });

  // Callers own operation spans; this wrapper only selects and tracks locks.
  const withLock = Effect.fnUntraced(function* <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
    initialShell?: Pick<OrchestrationV2ThreadShell, "lineage" | "linkedIssue">,
  ) {
    const key = yield* getThreadDispatchLockKey(threadId, initialShell);
    // Parent/child dispatch and provider ingestion can nest on the same root.
    const held = yield* HeldDispatchLocks;
    if (held.has(key)) return yield* effect;
    return yield* threadExecutor.withLock(
      key,
      effect.pipe(Effect.provideService(HeldDispatchLocks, new Set([...held, key]))),
    );
  });
  return { activeKeys: threadExecutor.activeKeys, withLock };
});
