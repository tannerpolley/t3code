import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";

import { randomUUID } from "../lib/utils";
import { waitForTitleEvaluation } from "../state/entities";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Command id for a Regenerate title request, so its outcome can be matched later. */
export const newTitleRegenerationRequestId = () => CommandId.make(randomUUID());

/**
 * Tells the user when a Regenerate title they asked for kept the title or failed. A changed
 * title speaks for itself. Luna at max effort can take a while, hence the long wait.
 */
export async function reportTitleRegenerationOutcome(
  threadRef: ScopedThreadRef,
  requestId: CommandId,
): Promise<void> {
  const outcome = await waitForTitleEvaluation(threadRef, requestId, 5 * 60_000);
  if (outcome === "unchanged") {
    toastManager.add(stackedThreadToast({ type: "info", title: "Title still fits" }));
  } else if (outcome === "failed") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not regenerate the title",
        description: "Title generation failed. The title was kept.",
      }),
    );
  }
}
