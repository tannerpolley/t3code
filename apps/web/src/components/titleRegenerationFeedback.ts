import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";

import { randomUUID } from "../lib/utils";
import { waitForTitleEvaluation } from "../state/entities";
import { type StackedThreadToastOptions, stackedThreadToast, toastManager } from "./ui/toast";

type TitleRegenerationOutcome = Awaited<ReturnType<typeof waitForTitleEvaluation>>;

/** Command id for a Regenerate title request, so its outcome can be matched later. */
export const newTitleRegenerationRequestId = () => CommandId.make(randomUUID());

/**
 * The toast for finished Regenerate title requests, or null when every title changed (a new
 * title speaks for itself). Requests that never reported back are left out.
 */
export function titleRegenerationToast(
  outcomes: ReadonlyArray<TitleRegenerationOutcome>,
): StackedThreadToastOptions | null {
  const count = (outcome: TitleRegenerationOutcome) =>
    outcomes.filter((candidate) => candidate === outcome).length;
  const changed = count("changed");
  const unchanged = count("unchanged");
  const failed = count("failed");
  if (unchanged + failed === 0) return null;
  if (changed + unchanged + failed === 1) {
    return failed === 1
      ? {
          type: "error",
          title: "Could not regenerate the title",
          description: "Title generation failed. The title was kept.",
        }
      : { type: "info", title: "Title still fits" };
  }
  return {
    type: failed > 0 ? "error" : "info",
    title:
      failed > 0
        ? `Could not regenerate ${failed} ${failed === 1 ? "title" : "titles"}`
        : `${unchanged} ${unchanged === 1 ? "title still fits" : "titles still fit"}`,
    description: `${changed} changed, ${unchanged} still fit, ${failed} failed.`,
  };
}

/**
 * Tells the user how the Regenerate title requests they sent together turned out, in one
 * toast. Luna at max effort can take a while, hence the long wait.
 */
export async function reportTitleRegenerationOutcomes(
  requests: ReadonlyArray<{ readonly threadRef: ScopedThreadRef; readonly requestId: CommandId }>,
): Promise<void> {
  const outcomes = await Promise.all(
    requests.map(({ threadRef, requestId }) =>
      waitForTitleEvaluation(threadRef, requestId, 5 * 60_000),
    ),
  );
  const toast = titleRegenerationToast(outcomes);
  if (toast !== null) toastManager.add(stackedThreadToast(toast));
}
