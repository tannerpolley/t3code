import { issueQueueMailbox } from "./IssueQueueStore.ts";
import type { OrchestrationV2DomainEvent, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Ref from "effect/Ref";
import type { ForkCommandHooks } from "../orchestration-v2/IssueWorkCommands.ts";

type Command<T extends OrchestrationV2ServerCommand["type"]> = Extract<
  OrchestrationV2ServerCommand,
  { type: T }
>;

export function makeIssueQueueCommands({
  issueWorkStore,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
}: ForkCommandHooks) {
  const change = Effect.fn("IssueQueueCommands.change")(function* (
    command: Command<"issue.queue.change">,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (Option.isNone(issueWorkStore)) return;
    const store = issueWorkStore.value;
    const owner = yield* store.repositoryOwner(command.issue).pipe(mapDispatchError(command));
    if (
      owner !== null &&
      owner.rootThreadId !== command.threadId &&
      command.threadId !== issueQueueMailbox(command.issue)
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Repository ownership changed. Retry the queue change.",
      });
    const current = (yield* store.queue(command.issue).pipe(mapDispatchError(command))).find(
      (entry) => entry.issue.id === command.issue.id,
    );
    if (command.queued ? current?.state === "queued" : current === undefined) return;
    if (command.queued) {
      if (
        (yield* store.queueWorkState(command.issue).pipe(mapDispatchError(command))) === "working"
      ) {
        const config = yield* store.configuration(command.threadId).pipe(mapDispatchError(command));
        if (!config?.suspendedIssues.some((entry) => entry.id === command.issue.id))
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "This issue already has work in progress.",
          });
      }
    }
    yield* emit(
      events,
      command,
    )<OrchestrationV2DomainEvent>({
      type: "issue.queue.updated",
      threadId: command.threadId,
      occurredAt: yield* DateTime.now,
      payload:
        current === undefined
          ? { requestId: command.commandId, issue: command.issue, state: "queued" }
          : { ...current, state: command.queued ? "queued" : "removed" },
    });
  });
  return { change };
}
