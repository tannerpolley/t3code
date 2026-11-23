import {
  repositoryAdmitsWork,
  repositoryPhase,
  isValidRepositoryPhase,
  type IssueSuspension,
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
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { DelegatedTaskRequest, ForkCommandHooks } from "./IssueWorkCommands.ts";
import type { OrchestratorV2Error, OrchestratorProjectionError } from "./Orchestrator.ts";
import {
  automaticHandoffMessageId,
  automaticHandoffThreadId,
  REPOSITORY_HANDOFF_READY,
  REPOSITORY_HANDOFF_VERIFICATION_TIMEOUT_MS,
} from "./AutomaticRepositoryHandoff.ts";
import { isOpenBlockerSuspension, isAutomaticIssueSuspension } from "../issues/IssueEligibility.ts";

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

export const planRepositoryWorkEnd = Effect.fn("orchestrationV2.planRepositoryWorkEnd")(function* (
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.end" }>,
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
  idAllocator: ForkCommandHooks["idAllocator"],
) {
  const config = thread.repositoryOrchestration;
  if (
    config === undefined ||
    repositoryPhase(config) === "retired" ||
    config.revision !== command.expectedRevision
  )
    return yield* Effect.fail("Repository ownership changed. Refresh before ending orchestration.");
  return {
    id: yield* idAllocator.allocate.event({
      threadId: command.threadId,
      commandId: command.commandId,
    }),
    type: "thread.metadata-updated" as const,
    threadId: command.threadId,
    occurredAt: now,
    payload: {
      ...thread,
      repositoryOrchestration: {
        ...config,
        paused: true,
        retiredToThreadId: null,
        revision: config.revision + 1,
      },
      updatedAt: now,
    },
  };
});

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
      {
        readonly type:
          | "thread.archive"
          | "thread.delete"
          | "repository.work.restore"
          | "repository.work.end";
      }
    >,
    thread: OrchestrationV2AppThread,
    // A paused root moving to its project's new record stays the same thread, so its own turns may run.
    moving = false,
  ) {
    if (
      thread.repositoryOrchestration === undefined ||
      repositoryPhase(thread.repositoryOrchestration) === "retired"
    )
      return;
    const projection = yield* projectionStore
      .getThreadRecords(thread.id, ["runs", "subagents"])
      .pipe(mapDispatchError(command));
    const unfinished =
      !moving &&
      (projection.runs.some(
        (run) =>
          !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
      ) ||
        projection.subagents.some(
          (task) =>
            !["completed", "failed", "cancelled", "interrupted"].includes(task.status) ||
            task.completionDelivery?.state === "pending" ||
            task.completionDelivery?.state === "claimed",
        ));
    const unclaimed = Option.isSome(issueWorkStore)
      ? yield* issueWorkStore.value.hasUnclaimedRequests(thread.id).pipe(mapDispatchError(command))
      : true;
    const queued =
      command.type !== "repository.work.restore" && Option.isSome(issueWorkStore)
        ? (yield* issueWorkStore.value
            .queue(thread.repositoryOrchestration)
            .pipe(mapDispatchError(command))).length > 0
        : false;
    const activePlan =
      !thread.repositoryOrchestration.paused &&
      thread.repositoryOrchestration.milestones.some((plan) => plan.status !== "complete");
    const subtreeActive =
      Option.isNone(issueWorkStore) ||
      (moving
        ? (yield* issueWorkStore.value.slotsInUse(thread.id).pipe(mapDispatchError(command))) > 0
        : !(yield* issueWorkStore.value.subtreeDrained(thread.id).pipe(mapDispatchError(command))));
    const blockers = [
      unfinished && "unfinished runs, subagents or final deliveries",
      queued && "queued issues (remove them from the queue)",
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
        cause: `This repository root still owns active work: ${blockers.join("; ")}. Resolve these or hand off ownership before ending, archiving, deleting or replacing this root.`,
      });
  });

  const guardDelegationParent = Effect.fn("guardDelegationParent")(function* (
    request: DelegatedTaskRequest,
    thread: OrchestrationV2AppThread,
  ) {
    if (
      thread.repositoryOrchestration !== undefined &&
      repositoryPhase(thread.repositoryOrchestration) === "retired"
    )
      return yield* new OrchestratorDispatchError({
        commandId: request.commandId,
        commandType: request.type,
        cause: `This repository root has retired. ${thread.repositoryOrchestration.retiredToThreadId == null ? "Set up repository orchestration again before delegating." : `Delegate through ${thread.repositoryOrchestration.retiredToThreadId}.`}`,
      });
  });

  const guardScheduledMessage = Effect.fn("guardScheduledMessage")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    thread: OrchestrationV2AppThread,
  ) {
    // Schedules resolve the repository owner before sending; a handoff can commit in between.
    if (
      (command.scheduledTaskId !== undefined ||
        (thread.handoffToThreadId !== undefined && command.createdBy === "system")) &&
      thread.repositoryOrchestration !== undefined &&
      repositoryPhase(thread.repositoryOrchestration) === "retired"
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `This repository root has retired. ${thread.repositoryOrchestration.retiredToThreadId == null ? "Set up repository orchestration again before scheduling work." : `Route scheduled work to ${thread.repositoryOrchestration.retiredToThreadId}.`}`,
      });
  });

  const end = Effect.fn("orchestrationV2.endRepositoryWork")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.end" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const shell = (yield* projectionStore
      .getThreadRecords(command.threadId, [])
      .pipe(mapDispatchError(command))).thread;
    const event = yield* planRepositoryWorkEnd(
      command,
      shell,
      yield* DateTime.now,
      idAllocator,
    ).pipe(mapDispatchError(command));
    yield* guardRootLifecycle(command, shell);
    yield* Ref.update(events, (current) => [...current, event]);
  });

  const restore = Effect.fn("restore")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.restore" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const restored = yield* issueWorkRecovery.restore(command).pipe(mapDispatchError(command));
    if (restored.idleRoot !== null)
      yield* guardRootLifecycle(command, restored.idleRoot, restored.ownTurnsMayRun);
    for (const event of restored.events)
      yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
  });

  const update = Effect.fn("orchestrationV2.updateRepositoryWork")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.update" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    if (
      !isValidRepositoryPhase(command.orchestration) ||
      repositoryPhase(command.orchestration) === "retired"
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Invalid repository orchestration phase.",
      });
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, [])
      .pipe(mapDispatchError(command));
    const shell = projection.thread;
    const prior = shell.repositoryOrchestration;
    if (
      prior === undefined ||
      repositoryPhase(prior) === "retired" ||
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
    const resumeReason = prior.suspendedIssues.find((entry) => entry.id === resumedIssueId);
    if (
      resumedIssueId !== undefined &&
      (!repositoryAdmitsWork(prior) ||
        repositoryPhase(prior) === "draining" ||
        !repositoryAdmitsWork(command.orchestration) ||
        repositoryPhase(command.orchestration) === "draining" ||
        !prior.suspendedIssues.some(
          (entry) => entry.id === resumedIssueId && isAutomaticIssueSuspension(entry),
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
      suspension: IssueSuspension,
      resumed = false,
    ) {
      const { reason } = suspension;
      if (!isAutomaticIssueSuspension(suspension)) {
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
              kind: suspension.kind,
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
            ? isOpenBlockerSuspension(suspension)
              ? `Issue #${issue.number} resumed: its issue host blockers are closed.`
              : `Issue #${issue.number} resumed: its issue host relationships are readable again.`
            : `Issue #${issue.number} paused: ${reason} Its workspace, link and results are retained. ${isOpenBlockerSuspension(suspension) ? "It resumes automatically when its issue host blockers close; no user decision is needed." : "It resumes automatically once issue host relationships are readable and the issue is eligible; no user decision is needed."}`,
          startedAt: existing?.startedAt ?? now,
          completedAt: now,
          updatedAt: now,
        },
      });
    });
    const changedSuspensions = command.orchestration.suspendedIssues.filter(
      (entry) =>
        !prior.suspendedIssues.some(
          (old) => old.id === entry.id && old.reason === entry.reason && old.kind === entry.kind,
        ),
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
        yield* notify(owner.linkedIssue, suspension);
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
            text: isOpenBlockerSuspension(resumeReason)
              ? `Issue #${owner.linkedIssue.number}'s issue host blockers are closed. Continue working on the issue from where you left off.`
              : `Issue #${owner.linkedIssue.number}'s issue host relationships are readable again. Continue working on the issue from where you left off.`,
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

  const continueWork = Effect.fn("continueWork")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.continue" }>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, [])
      .pipe(mapDispatchError(command));
    if (
      projection.thread.repositoryOrchestration === undefined ||
      repositoryPhase(projection.thread.repositoryOrchestration) === "retired"
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "This thread is not a repository orchestrator.",
      });
  });

  const handoff = Effect.fn("handoff")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "repository.work.handoff" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const shell = yield* projectionStore
      .getThread(command.threadId)
      .pipe(mapDispatchError(command));
    const config = shell.repositoryOrchestration;
    const automatic = command.automatic;
    const attempt = config?.automaticHandoff;
    if (
      config === undefined ||
      config.revision !== command.expectedRevision ||
      repositoryPhase(config) === "retired" ||
      (automatic === undefined
        ? config.handoff?.status !== "draining"
        : config.handoff !== undefined ||
          (automatic.type === "verify"
            ? attempt?.status !== "verifying"
            : attempt?.status === "verifying" || attempt?.sourceRunId === automatic.sourceRunId))
    )
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Repository ownership or the handoff changed. Refresh before transferring.",
      });
    const refuse = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    if (Option.isNone(issueWorkStore)) return yield* refuse("Repository work is unavailable.");
    const store = issueWorkStore.value;
    const owner = yield* store.repositoryOwner(config).pipe(mapDispatchError(command));
    if (owner?.rootThreadId !== command.threadId || owner.revision !== command.expectedRevision)
      return yield* refuse("Repository ownership revision conflict during handoff.");

    const now = yield* DateTime.now;
    const nextThreadId =
      automatic === undefined ? config.handoff!.nextThreadId : automaticHandoffThreadId(shell.id);
    const emitEvent = emit(events, command);
    const notice = Effect.fn("orchestrationV2.repositoryHandoffNotice")(function* (
      title: string,
      message: string,
    ) {
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: shell.id,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`handoff-notice:${command.commandId}`),
          type: "system_notice",
          threadId: shell.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal({ thread: shell, turnItems: [] }),
          status: "completed",
          title,
          message,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    });
    const failVerification = Effect.fn("orchestrationV2.failRepositoryHandoff")(function* (
      reason: string,
    ) {
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: shell.id,
        occurredAt: now,
        payload: {
          ...shell,
          repositoryOrchestration: {
            ...config,
            revision: config.revision + 1,
            automaticHandoff: { ...attempt!, status: "failed" },
          },
          updatedAt: now,
        },
      });
      yield* notice(
        "Automatic handoff deferred",
        `${reason} This thread still owns the repository.`,
      );
    });
    if (shell.archivedAt !== null || shell.deletedAt !== null)
      return yield* refuse("Restore the source thread before handing it off.");

    const sourceReady = Effect.gen(function* () {
      return (
        (yield* store.subtreeDrained(shell.id).pipe(mapDispatchError(command))) &&
        (automatic === undefined ||
          (yield* store.handoffSafe(shell.id).pipe(mapDispatchError(command))))
      );
    });

    if (automatic?.type !== "verify" && !(yield* sourceReady))
      return yield* refuse(
        "Handoff is waiting for the active issue subtree and final deliveries to drain.",
      );
    const existing = yield* projectionStore
      .getThreadShell(nextThreadId)
      .pipe(mapDispatchError(command));
    if (
      automatic?.type === "verify" &&
      (existing === null || existing.archivedAt !== null || existing.deletedAt !== null)
    )
      return yield* failVerification("The verification thread is unavailable.");
    if (existing === null)
      yield* dispatchThreadCreate(
        {
          type: "thread.create",
          commandId: command.commandId,
          threadId: nextThreadId,
          projectId: shell.projectId,
          title: shell.title,
          modelSelection: config.handoff?.modelSelection ?? shell.modelSelection,
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
    const startMessage = Effect.fn("orchestrationV2.repositoryHandoffMessage")(function* (
      messageId: MessageId,
      text: string,
      freshContext = false,
    ) {
      yield* dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: nextThreadId,
          messageId,
          text,
          ...(freshContext ? { freshContext } : {}),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        },
        events,
        effects,
      );
    });
    if (automatic?.type === "start") {
      if (
        (existing !== null && next.handoffFromThreadId !== shell.id) ||
        !(yield* store.subtreeDrained(nextThreadId).pipe(mapDispatchError(command)))
      )
        return yield* refuse("The verification thread is in use.");
      const source = yield* projectionStore
        .getThreadRecords(shell.id, ["runs", "providerThreads", "messages"], {
          latestRunLimit: 1,
          providerThreadIds:
            shell.activeProviderThreadId === null ? [] : [shell.activeProviderThreadId],
          messageRunIds: [automatic.sourceRunId],
          messageRoles: ["user", "assistant"],
        })
        .pipe(mapDispatchError(command));
      const contextTokens = source.providerThreads[0]?.contextUsage?.usedTokens;
      if (
        source.runs[0]?.id !== automatic.sourceRunId ||
        source.runs[0]?.status !== "completed" ||
        contextTokens === undefined ||
        contextTokens < automatic.threshold
      )
        return yield* refuse("Source context or its latest turn changed before verification.");
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: shell.id,
        occurredAt: now,
        payload: {
          ...shell,
          repositoryOrchestration: {
            ...config,
            revision: config.revision + 1,
            automaticHandoff: {
              sourceRunId: automatic.sourceRunId,
              requestId: command.commandId,
              contextTokens,
              startedAt: DateTime.formatIso(now),
              status: "verifying",
            },
          },
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: next.id,
        occurredAt: now,
        payload: {
          ...next,
          role: "orchestrator",
          title: shell.title,
          titleSource: "user",
          handoffFromThreadId: shell.id,
          modelSelection: shell.modelSelection,
          providerInstanceId: shell.providerInstanceId,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          branch: shell.branch,
          updatedAt: now,
        },
      });
      const recent = source.messages
        .slice(-8)
        .map((message) => `${message.role}: ${message.text.slice(-4_000)}`)
        .join("\n\n");
      yield* startMessage(
        automaticHandoffMessageId(command.commandId),
        `Verify a proposed context handoff for ${config.repository}. The current owner is ${shell.id}. Your first authorized action is read-only: use t3_thread_read to inspect that thread and confirm you can recover its current work from this brief and the source. Make no changes and start no work yet. If you can continue, summarize the current work and your first authorized next step, then end with the exact line "${REPOSITORY_HANDOFF_READY}". Otherwise report the blocker without that line. T3 transfers ownership after verification.

Server recovery inventory:
${command.inventory}

Recent source messages (historical context):
${recent}`,
        existing !== null,
      );
      return;
    }

    if (automatic?.type === "verify") {
      const verificationId = automaticHandoffMessageId(attempt!.requestId);
      const target = yield* projectionStore
        .getThreadRecords(next.id, ["runs"], {
          latestRunLimit: 1,
        })
        .pipe(mapDispatchError(command));
      const run = target.runs[0];
      const source = yield* projectionStore
        .getThreadRecords(shell.id, ["runs"], {
          latestRunLimit: 1,
        })
        .pipe(mapDispatchError(command));
      const expired =
        DateTime.toEpochMillis(now) - Date.parse(attempt!.startedAt) >=
        REPOSITORY_HANDOFF_VERIFICATION_TIMEOUT_MS;
      const candidateIdle = yield* store.subtreeDrained(next.id).pipe(mapDispatchError(command));
      if (
        automatic.enabled &&
        !candidateIdle &&
        !expired &&
        existing?.pendingRuntimeRequest == null
      )
        return yield* refuse("The verification turn is still running.");
      const proof =
        run?.userMessageId === verificationId && run.status === "completed"
          ? yield* projectionStore
              .getThreadRecords(next.id, ["messages", "turnItems"], {
                messageRoles: ["assistant"],
                messageRunIds: [run.id],
                turnItemRunIds: [run.id],
                turnItemTypes: ["dynamic_tool"],
              })
              .pipe(mapDispatchError(command))
          : undefined;
      const readSource = proof?.turnItems.some(
        (item) =>
          item.type === "dynamic_tool" &&
          item.status === "completed" &&
          /(?:^|\.|__)t3_thread_read$/.test(item.toolName ?? "") &&
          typeof item.input === "object" &&
          item.input !== null &&
          "threadId" in item.input &&
          item.input.threadId === shell.id,
      );
      const verified =
        automatic.enabled &&
        candidateIdle &&
        (yield* store.handoffSafe(next.id).pipe(mapDispatchError(command))) &&
        readSource &&
        proof?.messages.at(-1)?.text.trimEnd().split("\n").at(-1) === REPOSITORY_HANDOFF_READY;
      const sourceChanged =
        source.runs[0]?.id !== attempt!.sourceRunId ||
        !Equal.equals(next.modelSelection, shell.modelSelection) ||
        next.runtimeMode !== shell.runtimeMode ||
        next.interactionMode !== shell.interactionMode ||
        next.branch !== shell.branch ||
        next.worktreePath !== shell.worktreePath;
      if (!verified || sourceChanged)
        return yield* failVerification(
          !automatic.enabled
            ? "Automatic handoff was turned off."
            : sourceChanged
              ? "The source changed during verification."
              : "The successor did not verify the handoff.",
        );
      if (!(yield* sourceReady)) return yield* refuse("The source is no longer idle.");
      yield* notice(
        "Automatic handoff complete",
        `Handed off to ${next.title} at ${new Intl.NumberFormat("en", {
          notation: "compact",
        })
          .format(attempt!.contextTokens)
          .toLowerCase()} context.`,
      );
    }

    const paused = config.handoff?.wasPaused ?? config.paused;
    yield* emitEvent({
      type: automatic === undefined ? "thread.metadata-updated" : "thread.archived",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...shell,
        ...(automatic === undefined
          ? {}
          : {
              archivedAt: now,
              titleRegeneration: null,
              guestShare: null,
              handoffToThreadId: next.id,
              pullRequests: shell.pullRequests?.map(({ watch, ...link }) =>
                watch === undefined ? link : { ...link, endedWatch: watch },
              ),
            }),
        repositoryOrchestration: {
          ...config,
          automaticHandoff: undefined,
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
        ...(automatic === undefined
          ? {}
          : {
              pullRequests: shell.pullRequests,
              issues: shell.issues,
            }),
        repositoryOrchestration: {
          ...config,
          handoff: undefined,
          automaticHandoff: undefined,
          paused,
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
    yield* startMessage(
      idAllocator.derive.delegatedTaskMessage({ commandId: command.commandId }),
      automatic === undefined
        ? `You now own repository orchestration for ${config.repository}. The previous root ${command.threadId} has drained; its children and history retain their original lineage.\n\nHandoff summary:\n${config.handoff!.summary}\n\nServer recovery inventory:\n${command.inventory}\n\nContinue the approved repository work through the existing issue tools. Review completed attempts and pending changes before admitting successors. ${paused ? "Repository work remains paused until the user resumes it." : "Repository admissions may resume under this root."}`
        : `Verification succeeded. You now own repository orchestration for ${config.repository}. Continue the approved work from the handoff brief. ${paused ? "Repository work remains paused until the user resumes it." : "Repository admissions may resume under this root."}`,
    );
  });

  // Reads and validation occur before the caller takes these locks.
  const dispatchLockKeys = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
    if (command.type === "repository.work.restore") {
      // The target may have a linked issue, so coordinate with its existing root before restoring.
      const keys = yield* issueWorkRecovery
        .restoreLockKeys(command)
        .pipe(mapDispatchError(command));
      return keys;
    }
    if (command.type === "repository.work.handoff") {
      const root = yield* projectionStore
        .getThread(command.threadId)
        .pipe(mapDispatchError(command));
      const targetId =
        command.automatic === undefined
          ? root.repositoryOrchestration?.handoff?.nextThreadId
          : automaticHandoffThreadId(root.id);
      if (targetId !== undefined) {
        const target = yield* projectionStore
          .getThreadShell(targetId)
          .pipe(mapDispatchError(command));
        if (
          target !== null &&
          (target.lineage.parentThreadId !== null || target.lineage.rootThreadId !== target.id)
        )
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Select an existing active top-level thread in the same repository project.",
          });
        return [...new Set([command.threadId, targetId])].sort();
      }
    }
    return undefined;
  });

  // Receipt replay, empty plans and committed commands resume admissions at the same point.
  const continueQueues = Effect.fnUntraced(function* <E, R>(
    command: OrchestrationV2ServerCommand,
    startNextQueuedRun: (id: ThreadId) => Effect.Effect<void, E, R>,
  ) {
    if (command.type === "repository.work.continue" && Option.isSome(issueWorkStore)) {
      for (const threadId of yield* issueWorkStore.value
        .admissionThreads(command.threadId)
        .pipe(mapDispatchError(command)))
        yield* mapDispatchError(command)(startNextQueuedRun(threadId));
    }
  });

  // Thread creation's enclosing dispatch span owns this validation.
  const guardThreadCreate = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { type: "thread.create" }>,
    thread: OrchestrationV2AppThread,
  ) {
    if (thread.repositoryOrchestration !== undefined) {
      if (!isValidRepositoryPhase(thread.repositoryOrchestration))
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Invalid repository orchestration phase.",
        });
      const adapter = yield* providerAdapters
        .get(thread.modelSelection.instanceId)
        .pipe(mapDispatchError(command));
      if (!isRepositoryOrchestratorEligible(thread, adapter.driver, thread.repositoryOrchestration))
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          detail:
            "Select an active top-level Orchestrator thread in the same repository project using Codex or Claude.",
        });
    }
  });

  return {
    guardThreadCreate,
    continueQueues,
    dispatchLockKeys,
    guardRootLifecycle,
    guardDelegationParent,
    guardScheduledMessage,
    end,
    restore,
    update,
    continueWork,
    handoff,
  };
}
