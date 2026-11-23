import { CommandId, MessageId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";

export const automaticHandoffThreadId = (source: ThreadId) =>
  ThreadId.make(`repository-handoff-successor:${source}`);

export const automaticHandoffMessageId = (attempt: CommandId) =>
  MessageId.make(`repository-handoff-verify:${attempt}`);

export const REPOSITORY_HANDOFF_VERIFICATION_TIMEOUT_MS = 15 * 60_000;

export const REPOSITORY_HANDOFF_READY = "Repository handoff verified.";

export const automaticHandoffCompletion = (
  from: ThreadId,
  task: OrchestrationV2Subagent,
  generation: string,
) => {
  const commandId = CommandId.make(`handoff-completion:${task.id}:${generation}`);
  return {
    id: String(commandId),
    commandId,
    threadId: from,
    request: {
      type: "repository.handoff-completion" as const,
      text: `A delegated task from the previous repository orchestrator finished.\n\n${task.title ?? task.id} (${task.status})\n${task.result ?? ""}`,
    },
  };
};
