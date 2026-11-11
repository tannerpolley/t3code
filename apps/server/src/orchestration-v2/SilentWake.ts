import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

export const SILENT_WAKE_FOLLOWUP =
  "Your last turn ended without a reply; report the result of the finished work or continue working.";
export const SILENT_WAKE_ATTENTION = "The agent ended two turns in a row without a reply";

export function silentWakeAction(message: OrchestrationV2ConversationMessage | undefined) {
  if (message?.silentWakeFollowupOfRunId !== undefined) return "attention";
  if (
    message?.delegatedCompletion !== undefined ||
    message?.creationSource === "provider" ||
    message?.notification !== undefined
  )
    return "nudge";
  return "none";
}
