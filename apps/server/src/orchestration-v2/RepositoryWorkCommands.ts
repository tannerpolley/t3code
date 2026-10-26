import {
  CommandId,
  isRepositoryOrchestratorEligible,
  MessageId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { DelegatedTaskRequest, ForkCommandHooks } from "./IssueWorkCommands.ts";
import type { OrchestratorV2Error, OrchestratorProjectionError } from "./Orchestrator.ts";
import {
  openBlockerSuspensionReason,
  isAutomaticIssueSuspension,
} from "../issues/IssueEligibility.ts";

interface RepositoryWorkCommandHooks extends ForkCommandHooks {
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
  ) => Effect.Effect<number, OrchestratorProjectionError>;
  readonly providerAdapters: ProviderAdapterRegistryV2["Service"];
  readonly dispatchThreadCreate: (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly recordSubagentFollowup: (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorProjectionError>;
}

// Ownership decisions collect events and effects in the caller's existing command plan.
export function makeRepositoryWorkCommands({
  issueWorkStore,
  providerAdapters,
  issueWorkRecovery,
  projectionStore,
  idAllocator,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
  dispatchThreadCreate,
  dispatchMessage,
  recordSubagentFollowup,
  getProjectionWithPendingEvents,
  nextTurnItemOrdinal,
}: RepositoryWorkCommandHooks) {
  const guardRootLifecycle = Effect.fn("orchestrationV2.guardRepositoryRootLifecycle")(function* (
    command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "thread.archive" | "repository.work.restore" }
    >,
    thread: OrchestrationV2AppThread,
  ) {
    if (
      thread.repositoryOrchestration === undefined ||
      thread.repositoryOrchestration.retiredToThreadId !== undefined
    )
      return;
    const projection = yield* projectionStore
      .getThreadRecords(thread.id, ["runs", "subagents"])
      .pipe(mapDispatchError(command));
    const unfinished =
      projection.runs.some(
        (run) =>
          !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
      ) ||
      projection.subagents.some(
        (task) =>
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status) ||
          task.completionDelivery?.state === "pending" ||
          task.completionDelivery?.state === "claimed",
      );
    const unclaimed = Option.isSome(issueWorkStore)
      ? yield* issueWorkStore.value.hasUnclaimedRequests(thread.id).pipe(mapDispatchError(command))
      : true;
    const activePlan =
      !thread.repositoryOrchestration.paused &&
      thread.repositoryOrchestration.milestones.some((plan) => plan.status !== "complete");
    const subtreeActive =
      Option.isNone(issueWorkStore) ||
      !(yield* issueWorkStore.value.subtreeDrained(thread.id).pipe(mapDispatchError(command)));
    const blockers = [
      unfinished && "unfinished runs, subagents or final deliveries",
      unclaimed &&
        "unclaimed issue start requests (cancel them from the issue's Start agent controls)",
      activePlan && "an unpaused milestone plan (pause the repository)",
      subtreeActive && "active issue workers",
      thread.repositoryOrchestration.handoff !== undefined && "a pending handoff",
    ].filter((blocker) => blocker !== false);
    if (blockers.length > 0)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `This repository root still owns active work: ${blockers.join("; ")}. Resolve these or hand off ownership before archiving or replacing this root.`,
      });
  });

  const guardDelegationParent = (request: DelegatedTaskRequest, thread: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      if (thread.repositoryOrchestration?.retiredToThreadId !== undefined)
        return yield* new OrchestratorDispatchError({
          commandId: request.commandId,
          commandType: request.type,
          cause: `This repository root has retired. Delegate through ${thread.repositoryOrchestration.retiredToThreadId}.`,
        });
    });

  const guardScheduledMessage = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    thread: OrchestrationV2AppThread,
  ) =>
    Effect.gen(function* () {
      // Schedules resolve the repository owner before sending; a handoff can commit in between.
      if (
        command.scheduledTaskId !== undefined &&
        thread.repositoryOrchestration?.retiredToThreadId !== undefined
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `This repository root has retired. Route scheduled work to ${thread.repositoryOrchestration.retiredToThreadId}.`,
        });
    });

  const restore = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.restore" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const restored = yield* issueWorkRecovery.restore(command).pipe(mapDispatchError(command));
      if (restored.retiringRoot !== null) yield* guardRootLifecycle(command, restored.retiringRoot);
      for (const event of restored.events)
        yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
    });

  const update = Effect.fn("orchestrationV2.updateRepositoryWork")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.update" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, [])
      .pipe(mapDispatchError(command));
    const shell = projection.thread;
    const prior = shell.repositoryOrchestration;
    if (
      prior === undefined ||
      prior.retiredToThreadId !== undefined ||
      prior.revision !== command.expectedRevision ||
      prior.repositoryId !== command.orchestration.repositoryId ||
      prior.host !== command.orchestration.host ||
      prior.projectId !== command.orchestration.projectId ||
      prior.launchCommandId !== command.orchestration.launchCommandId
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Repository ownership changed. Refresh before updating work.",
      });
    const now = yield* DateTime.now;
    const resumedIssueId = command.resumeBlockedIssueId;
    const resumeReason = prior.suspendedIssues.find((entry) => entry.id === resumedIssueId)?.reason;
    if (
      resumedIssueId !== undefined &&
      (prior.paused ||
        prior.handoff?.status === "draining" ||
        command.orchestration.paused ||
        command.orchestration.handoff?.status === "draining" ||
        !prior.suspendedIssues.some(
          (entry) => entry.id === resumedIssueId && isAutomaticIssueSuspension(entry.reason),
        ) ||
        command.orchestration.suspendedIssues.some((entry) => entry.id === resumedIssueId))
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Only an active repository's transient suspension can resume automatically.",
      });
    yield* emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...shell,
        repositoryOrchestration: { ...command.orchestration, revision: prior.revision + 1 },
        updatedAt: now,
      },
    });
    // Notice emission is part of the repository update's command plan and span.
    const notify = Effect.fnUntraced(function* (
      issue: ThreadLinkedIssue,
      reason: string,
      resumed = false,
    ) {
      if (!isAutomaticIssueSuspension(reason)) {
        yield* Ref.update(effects, (pending) => [
          ...pending,
          {
            id: `effect:${command.commandId}:issue-decision:${issue.id}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "issue.suspension.notify",
              projectId: prior.projectId,
              issue,
              reason,
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
        return;
      }
      const id = TurnItemId.make(`issue-suspension:${command.threadId}:${issue.id}`);
      const existing = yield* projectionStore
        .getTurnItem({ threadId: command.threadId, itemId: id })
        .pipe(mapDispatchError(command));
      const pendingItems = (yield* Ref.get(events)).flatMap((event) =>
        event.type === "turn-item.updated" && event.threadId === command.threadId
          ? [event.payload]
          : [],
      );
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: {
          id,
          type: "system_notice",
          threadId: command.threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            existing?.ordinal ??
            (yield* nextTurnItemOrdinal({ thread: shell, turnItems: pendingItems })),
          status: "completed",
          title: `Issue #${issue.number} ${resumed ? "resumed" : "paused"}`,
          message: resumed
            ? reason === openBlockerSuspensionReason
              ? `Issue #${issue.number} resumed: its GitHub blockers are closed.`
              : `Issue #${issue.number} resumed: its GitHub relationships are readable again.`
            : `Issue #${issue.number} paused: ${reason} Its workspace, link and results are retained. ${reason === openBlockerSuspensionReason ? "It resumes automatically when its GitHub blockers close; no user decision is needed." : "It resumes automatically once GitHub relationships are readable and the issue is eligible; no user decision is needed."}`,
          startedAt: existing?.startedAt ?? now,
          completedAt: now,
          updatedAt: now,
        },
      });
    });
    const changedSuspensions = command.orchestration.suspendedIssues.filter(
      (entry) =>
        !prior.suspendedIssues.some((old) => old.id === entry.id && old.reason === entry.reason),
    );
    if (
      (changedSuspensions.length > 0 || resumedIssueId !== undefined) &&
      Option.isSome(issueWorkStore)
    ) {
      const workers = yield* Effect.forEach(
        yield* issueWorkStore.value.workerThreads(command.threadId).pipe(mapDispatchError(command)),
        (threadId) => projectionStore.getThreadShell(threadId).pipe(mapDispatchError(command)),
      );
      for (const suspension of changedSuspensions) {
        const owner = workers.find((worker) => worker?.linkedIssue?.id === suspension.id);
        if (owner?.linkedIssue === undefined) continue;
        const branch = new Set([owner.id]);
        for (let size = -1; size !== branch.size;) {
          size = branch.size;
          for (const worker of workers)
            if (worker?.lineage.parentThreadId != null && branch.has(worker.lineage.parentThreadId))
              branch.add(worker.id);
        }
        for (const worker of workers) {
          if (worker?.activeRunId == null || !branch.has(worker.id)) continue;
          yield* Ref.update(effects, (pending) => [
            ...pending,
            {
              id: `effect:${command.commandId}:issue-suspend:${suspension.id}:${worker.activeRunId}`,
              commandId: command.commandId,
              threadId: worker.id,
              request: { type: "issue.suspension.interrupt", runId: worker.activeRunId! },
            } satisfies PendingOrchestrationEffectV2,
          ]);
        }
        yield* notify(owner.linkedIssue, suspension.reason);
      }
      const owner = workers.find((worker) => worker?.linkedIssue?.id === resumedIssueId);
      if (resumedIssueId !== undefined && owner?.linkedIssue !== undefined) {
        const projection = yield* projectionStore
          .getThreadRecords(owner.id, ["runs"])
          .pipe(mapDispatchError(command));
        const latest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (
          latest !== undefined &&
          (latest.status === "interrupted" || owner.activeRunId !== null) &&
          !projection.runs.some((run) => run.status === "queued")
        ) {
          const message = {
            type: "message.dispatch",
            commandId: CommandId.make(`${command.commandId}:worker`),
            threadId: owner.id,
            senderThreadId: owner.lineage.parentThreadId!,
            messageId: MessageId.make(`${command.commandId}:worker`),
            text:
              resumeReason === openBlockerSuspensionReason
                ? `Issue #${owner.linkedIssue.number}'s GitHub blockers are closed. Continue working on the issue from where you left off.`
                : `Issue #${owner.linkedIssue.number}'s GitHub relationships are readable again. Continue working on the issue from where you left off.`,
            attachments: [],
            modelSelection: latest.modelSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          } satisfies Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;
          // The committed suspension still denies admission; this turn queues atomically with its removal.
          yield* dispatchMessage(message, events, effects);
          yield* recordSubagentFollowup(message, events);
        }
        yield* notify(owner.linkedIssue, resumeReason!, true);
      }
    }
  });

  const continueWork = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.continue" }>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, [])
        .pipe(mapDispatchError(command));
      if (
        projection.thread.repositoryOrchestration === undefined ||
        projection.thread.repositoryOrchestration.retiredToThreadId !== undefined
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This thread is not a repository orchestrator.",
        });
    });

  const handoff = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.handoff" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const shell = yield* projectionStore
        .getThread(command.threadId)
        .pipe(mapDispatchError(command));
      const config = shell.repositoryOrchestration;
      if (
        config?.handoff?.status !== "draining" ||
        config.revision !== command.expectedRevision ||
        config.retiredToThreadId !== undefined
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Repository ownership or the handoff changed. Refresh before transferring.",
        });
      const owner = Option.isNone(issueWorkStore)
        ? null
        : yield* issueWorkStore.value.repositoryOwner(config).pipe(mapDispatchError(command));
      if (owner?.rootThreadId !== command.threadId || owner.revision !== command.expectedRevision)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Repository ownership revision conflict during handoff.",
        });
      if (
        Option.isNone(issueWorkStore) ||
        !(yield* issueWorkStore.value
          .subtreeDrained(command.threadId)
          .pipe(mapDispatchError(command)))
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Handoff is waiting for the active issue subtree and final deliveries to drain.",
        });
      const now = yield* DateTime.now;
      const nextThreadId = config.handoff.nextThreadId;
      const existing = yield* projectionStore
        .getThreadShell(nextThreadId)
        .pipe(mapDispatchError(command));
      if (existing === null)
        yield* dispatchThreadCreate(
          {
            type: "thread.create",
            commandId: command.commandId,
            threadId: nextThreadId,
            projectId: shell.projectId,
            title: shell.title,
            modelSelection: config.handoff.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            branch: shell.branch,
            worktreePath: shell.worktreePath,
            createdBy: "user",
            creationSource: "server",
          },
          events,
        );
      const next = (yield* getProjectionWithPendingEvents(nextThreadId, events)).thread;
      const adapter = yield* providerAdapters
        .get(next.modelSelection.instanceId)
        .pipe(mapDispatchError(command));
      if (next.id === shell.id || !isRepositoryOrchestratorEligible(next, adapter.driver, config))
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "Select an existing active top-level Orchestrator thread in the same repository project using Codex or Claude.",
        });
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: {
          ...shell,
          repositoryOrchestration: {
            ...config,
            handoff: undefined,
            retiredToThreadId: nextThreadId,
          },
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: nextThreadId,
        occurredAt: now,
        payload: {
          ...next,
          role: "orchestrator",
          repositoryOrchestration: {
            ...config,
            handoff: undefined,
            paused: config.handoff.wasPaused,
            revision: config.revision + 1,
            launchCommandId: command.commandId,
            handoffHistory: [
              ...(config.handoffHistory ?? []),
              { threadId: command.threadId, transferredAt: DateTime.formatIso(now) },
            ],
          },
          updatedAt: now,
        },
      });
      yield* dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: nextThreadId,
          messageId: idAllocator.derive.delegatedTaskMessage({ commandId: command.commandId }),
          text: `You now own repository orchestration for ${config.repository}. The previous root ${command.threadId} has drained; its children and history retain their original lineage.\n\nHandoff summary:\n${config.handoff.summary}\n\nServer recovery inventory:\n${command.inventory}\n\nContinue the approved repository work through the existing issue tools. Review completed attempts and pending changes before admitting successors. ${config.handoff.wasPaused ? "Repository work remains paused until the user resumes it." : "Repository admissions may resume under this root."}`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        },
        events,
        effects,
      );
    });

  return {
    guardRootLifecycle,
    guardDelegationParent,
    guardScheduledMessage,
    restore,
    update,
    continueWork,
    handoff,
  };
}
