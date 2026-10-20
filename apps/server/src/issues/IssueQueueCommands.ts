import {
  type IssueQueueEntry,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  IssueQueueReads,
  IssueQueueRefreshRequired,
} from "../orchestration-v2/IssueWorkDispatch.ts";
import { sameIssueRepository } from "./IssueEligibility.ts";
import type { ForkCommandHooks } from "../orchestration-v2/IssueWorkCommands.ts";
import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";

type Command<T extends OrchestrationV2ServerCommand["type"]> = Extract<
  OrchestrationV2ServerCommand,
  { type: T }
>;

export const issueQueueMessage = (entry: IssueQueueEntry) =>
  `Queued issue #${entry.issue.number}: ${entry.issue.title}\n${entry.issue.url}\n\nStart an implementor agent for this issue with delegate_task and its issue argument: ${JSON.stringify({ host: entry.issue.host, repository: entry.issue.repository, number: entry.issue.number })}. Use the existing managed-issue path so the worker gets its own issue worktree and shares the repository worker limit.`;

export function makeIssueQueueCommands(
  hooks: ForkCommandHooks & {
    readonly dispatchMessage: (
      command: Command<"message.dispatch">,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) => Effect.Effect<void, OrchestratorV2Error>;
  },
) {
  const { issueWorkStore, projectionStore, emit, mapDispatchError, OrchestratorDispatchError } =
    hooks;
  const change = Effect.fn("IssueQueueCommands.change")(function* (
    command: Command<"issue.queue.change">,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (Option.isNone(issueWorkStore)) return;
    const store = issueWorkStore.value;
    const owner = yield* store.repositoryOwner(command.issue).pipe(mapDispatchError(command));
    if (owner !== null && owner.rootThreadId !== command.threadId)
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
      const owner = yield* store.currentIssueOwner(command.issue).pipe(mapDispatchError(command));
      const pending = yield* store.latestRequest(command.issue).pipe(mapDispatchError(command));
      const ownerShell =
        owner === null
          ? null
          : yield* projectionStore.getThreadShell(owner).pipe(mapDispatchError(command));
      if (
        (owner !== null &&
          (ownerShell?.activeRunId != null ||
            !(yield* store.resultAvailable(owner).pipe(mapDispatchError(command))))) ||
        (owner === null && pending !== null && pending.cancellation === undefined)
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This issue already has work in progress.",
        });
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
          : { ...current, state: command.queued ? "queued" : "removed", noticeRunId: undefined },
    });
  });
  const deliver = Effect.fn("IssueQueueCommands.deliver")(function* (
    command: Command<"issue.queue.deliver">,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    if (Option.isNone(issueWorkStore)) return;
    const store = issueWorkStore.value;
    const config = yield* store.configuration(command.threadId).pipe(mapDispatchError(command));
    if (
      config === null ||
      config.paused ||
      config.handoff !== undefined ||
      config.retiredToThreadId !== undefined
    )
      return;
    const owner = yield* store.repositoryOwner(config).pipe(mapDispatchError(command));
    if (
      owner?.rootThreadId !== command.threadId ||
      (yield* store.slotsInUse(command.threadId).pipe(mapDispatchError(command))) >=
        config.workerLimit
    )
      return;
    if (!(yield* store.queueRootIdle(command.threadId).pipe(mapDispatchError(command)))) return;
    const queue = yield* store.queue(config).pipe(mapDispatchError(command));
    if (queue.some((entry) => entry.noticeRunId !== undefined)) return;
    const reads = yield* IssueQueueReads;
    let entry: IssueQueueEntry | undefined;
    for (const candidate of queue) {
      if (candidate.state !== "queued") continue;
      const owner = yield* store.currentIssueOwner(candidate.issue).pipe(mapDispatchError(command));
      const pending = yield* store.latestRequest(candidate.issue).pipe(mapDispatchError(command));
      const ownerShell =
        owner === null
          ? null
          : yield* projectionStore.getThreadShell(owner).pipe(mapDispatchError(command));
      const working =
        owner === null
          ? pending !== null && pending.cancellation === undefined
          : ownerShell?.activeRunId != null ||
            !(yield* store.resultAvailable(owner).pipe(mapDispatchError(command)));
      const read = reads.find(
        (read) =>
          sameIssueRepository(read.issue, candidate.issue) && read.issue.id === candidate.issue.id,
      );
      if (working || read?.outcome === "closed" || read?.outcome === "worked") {
        yield* emit(
          events,
          command,
        )<OrchestrationV2DomainEvent>({
          type: "issue.queue.updated",
          threadId: command.threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...candidate, state: "removed" },
        });
        continue;
      }
      if (read === undefined)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: new IssueQueueRefreshRequired(),
        });
      entry = candidate;
      break;
    }
    if (entry === undefined) return;
    yield* hooks.dispatchMessage(
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: hooks.idAllocator.derive.delegatedTaskMessage({
          commandId: command.commandId,
        }),
        text: issueQueueMessage(entry),
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      },
      events,
      effects,
    );
    const run = (yield* Ref.get(events)).find((event) => event.type === "run.created");
    if (run?.type !== "run.created")
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Queue delivery did not create a run.",
      });
    yield* emit(
      events,
      command,
    )<OrchestrationV2DomainEvent>({
      type: "issue.queue.updated",
      threadId: command.threadId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...entry,
        noticeRunId: run.payload.id,
        notifiedAt: DateTime.formatIso(yield* DateTime.now),
      },
    });
  });
  return { change, deliver };
}
