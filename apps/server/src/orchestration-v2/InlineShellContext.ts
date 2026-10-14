import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  RunAttemptId,
  ProviderThreadId,
} from "@t3tools/contracts";
import { inlineShellContext } from "@t3tools/shared/inlineShell";
import * as DateTime from "effect/DateTime";

/** Runs finishing during a turn belong to the following prompt, even after reconnect. */
export function pendingInlineShellContext(
  items: readonly OrchestrationV2TurnItem[],
  turns: readonly OrchestrationV2ProviderTurn[],
  currentAttemptId: RunAttemptId,
  providerThreadId: ProviderThreadId,
  replayAll = false,
): string {
  const deliveredBefore = replayAll
    ? 0
    : Math.max(
        0,
        ...turns
          .filter(
            (turn) =>
              turn.runAttemptId !== currentAttemptId &&
              turn.providerThreadId === providerThreadId &&
              turn.startedAt !== null,
          )
          .map((turn) => DateTime.toEpochMillis(turn.startedAt!)),
      );
  return inlineShellContext(
    items.flatMap((item) =>
      item.type === "system_notice" &&
      item.inlineShellRun !== undefined &&
      item.inlineShellRun.completedAt !== null &&
      Date.parse(item.inlineShellRun.completedAt) >= deliveredBefore
        ? [item.inlineShellRun]
        : [],
    ),
  );
}
