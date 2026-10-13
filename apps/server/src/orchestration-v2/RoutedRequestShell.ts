import type {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Include the dependency even when coalescing or client buffering separates parent and child deltas. */
export const withRoutedRequestParent = Effect.fn("withRoutedRequestParent")(function* <E>(
  item: OrchestrationV2ShellStreamItem,
  readShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E>,
) {
  if (item.kind !== "thread.updated" || item.thread.pendingRuntimeRequest?.routedTo === undefined)
    return item;
  return {
    ...item,
    routedRequestParent: yield* readShell(item.thread.pendingRuntimeRequest.routedTo),
  };
});
