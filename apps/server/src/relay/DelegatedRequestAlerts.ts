import type { OrchestrationV2ThreadShell, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  ROUTED_REQUEST_ALERT_SETTLE_MS,
  runtimeRequestOwnerAlertIsSettled,
} from "@t3tools/shared/delegatedRequestVisibility";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export function makeDelegatedRequestAlerts(
  scope: Scope.Scope,
  enqueue: (threadId: ThreadId) => Effect.Effect<void>,
) {
  const settlingRequests = new Map<ThreadId, { requestId: RuntimeRequestId; since: number }>();
  // The relay publish operation owns the span for each visibility check.
  const isSettled = Effect.fnUntraced(function* (
    threadId: ThreadId,
    threadShell: OrchestrationV2ThreadShell | null,
    ownerVisible: boolean,
  ) {
    const request = threadShell?.pendingRuntimeRequest;
    if (
      request?.routedTo === undefined ||
      !ownerVisible ||
      threadShell?.archivedAt !== null ||
      threadShell.deletedAt !== null
    ) {
      settlingRequests.delete(threadId);
    } else {
      const now = (yield* DateTime.now).epochMilliseconds;
      let settling = settlingRequests.get(threadId);
      if (settling?.requestId !== request.id) {
        settling = { requestId: request.id, since: now };
        settlingRequests.set(threadId, settling);
        const pending = settling;
        yield* Effect.sleep(ROUTED_REQUEST_ALERT_SETTLE_MS).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              settlingRequests.get(threadId) === pending ? enqueue(threadId) : Effect.void,
            ),
          ),
          Effect.forkIn(scope),
        );
      }
      if (!runtimeRequestOwnerAlertIsSettled(request, settling.since, now)) return false;
    }
    return true;
  });
  return { isSettled, clear: () => settlingRequests.clear() };
}
