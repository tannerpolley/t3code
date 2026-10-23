import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import type { ForkCommandHooks } from "./IssueWorkCommands.ts";
import type {
  OrchestratorProjectionError,
  OrchestratorV2DispatchResult,
  OrchestratorV2Error,
} from "./Orchestrator.ts";
import type {
  threadShellFromProjection,
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "./ProjectionStore.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type { isSnoozed } from "./ThreadSettlementService.ts";
import { usageLimitQueuedRunEvents } from "./usageLimitQueuedRuns.ts";
import type {
  usageLimitRecoveryPending,
  usageLimitSwitchMessageId,
} from "./usageLimitRecoveryPending.ts";

interface AutomaticProviderSwitchHooks<RestartError> extends Pick<
  ForkCommandHooks,
  "projectionStore" | "idAllocator" | "emit" | "mapDispatchError" | "OrchestratorDispatchError"
> {
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError>;
  readonly dispatchWithReceiptEffect: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
  readonly awaitsRestartContinuation: (
    run: OrchestrationV2Run,
  ) => Effect.Effect<boolean, RestartError>;
  readonly threadShellFromProjection: typeof threadShellFromProjection;
  readonly isSnoozed: typeof isSnoozed;
  readonly usageLimitRecoveryPending: typeof usageLimitRecoveryPending;
  readonly usageLimitSwitchMessageId: typeof usageLimitSwitchMessageId;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
}

// Dispatch owns the locks and collectors; recovery reads remain at the original hook sites.
export function makeAutomaticProviderSwitchPolicy<RestartError>({
  projectionStore,
  idAllocator,
  emit,
  mapDispatchError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  loadProjectionForCommand,
  nextTurnItemOrdinal,
  dispatchWithReceiptEffect,
  getProjectionWithPendingEvents,
  isBlockingRun,
  awaitsRestartContinuation,
  serverSettings,
  threadShellFromProjection,
  isSnoozed,
  usageLimitRecoveryPending,
  usageLimitSwitchMessageId,
}: AutomaticProviderSwitchHooks<RestartError>) {
  // These hooks run inside existing orchestration spans.
  const guardMutation = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
  ) {
    if (
      (command.type === "provider.switch" || command.type === "thread.metadata.update") &&
      command.autoProviderSwitch !== undefined
    ) {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "turnItems", "runtimeRequests"],
        { turnItemTypes: ["error"] },
      );
      const source = latestExecutedRun(projection.runs);
      const marker = command.autoProviderSwitch;
      if (
        source?.id !== marker.runId ||
        source.status !== "failed" ||
        latestRootProviderFailure(source, projection.turnItems)?.class !== "usage_limit" ||
        !modelSelectionsEqual(source.modelSelection, marker.from) ||
        !modelSelectionsEqual(thread.modelSelection, marker.from) ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.settledOverride === "settled" ||
        thread.repositoryOrchestration?.retiredToThreadId !== undefined ||
        projection.runs.some(isBlockingRun) ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This usage-limit failure can no longer switch provider.",
        });
      }
    }
  });
  const emitNotice = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
    now: DateTime.Utc,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (
      (command.type === "provider.switch" || command.type === "thread.metadata.update") &&
      command.autoProviderSwitch !== undefined
    ) {
      const marker = command.autoProviderSwitch;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: marker.runId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.runSignalTurnItem({
            runId: marker.runId,
            signal: "auto-provider-switch",
          }),
          type: "system_notice",
          threadId: command.threadId,
          runId: marker.runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal({ thread, turnItems: [] }),
          status: "completed",
          title: marker.to === null ? "Waiting for reset" : "Provider switched automatically",
          message: marker.message,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
  });
  const guardContinuation = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    projection: OrchestrationV2ThreadProjection,
  ) {
    if (command.automaticProviderContinuationOfRunId !== undefined) {
      const marker = projection.thread.autoProviderSwitch;
      const source = latestExecutedRun(projection.runs);
      const shell = threadShellFromProjection(projection);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const released =
        projection.thread.lineage.parentThreadId !== null &&
        (yield* projectionStore
          .isUsageLimitFailureReleased(
            command.threadId,
            command.automaticProviderContinuationOfRunId,
          )
          .pipe(mapDispatchError(command)));
      if (
        released ||
        source?.id !== command.automaticProviderContinuationOfRunId ||
        source.status !== "failed" ||
        latestRootProviderFailure(source, projection.turnItems)?.class !== "usage_limit" ||
        marker?.runId !== source.id ||
        marker.to === null ||
        !modelSelectionsEqual(projection.thread.modelSelection, marker.to) ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled" ||
        isSnoozed(shell, nowMs) ||
        projection.thread.repositoryOrchestration?.retiredToThreadId !== undefined ||
        projection.runs.some(isBlockingRun) ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This automatic provider switch can no longer continue.",
        });
      }
    }
  });
  const continuedTaskId = (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const continuationOf =
      command.restartContinuationOfRunId ?? command.automaticProviderContinuationOfRunId;
    const continuedTaskId =
      continuationOf === undefined
        ? undefined
        : (projection.runs.find((run) => run.id === continuationOf)?.delegatedTaskId ??
          (projection.thread.lineage.relationshipToParent === "subagent" &&
          projection.thread.forkedFrom?.type === "node"
            ? projection.thread.forkedFrom.nodeId
            : undefined));
    return continuedTaskId;
  };
  const queuedContinuationReleased = Effect.fnUntraced(function* (
    threadId: ThreadId,
    projection: Pick<OrchestrationV2ThreadProjection, "thread">,
    queuedRun: OrchestrationV2Run,
  ) {
    const marker = projection.thread.autoProviderSwitch;
    return (
      marker &&
      queuedRun.userMessageId === usageLimitSwitchMessageId(threadId, marker.runId) &&
      (yield* projectionStore
        .isUsageLimitFailureReleased(threadId, marker.runId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))))
    );
  });
  const withdrawReleasedContinuation = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { thread, runs } = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
    const marker = thread.autoProviderSwitch;
    if (
      !marker ||
      thread.lineage.parentThreadId === null ||
      !(yield* projectionStore.isUsageLimitFailureReleased(threadId, marker.runId))
    )
      return;
    const continuation = runs.find(
      (run) => run.userMessageId === usageLimitSwitchMessageId(threadId, marker.runId),
    );
    if (
      !continuation ||
      continuation.startedAt !== null ||
      !["queued", "preparing", "starting"].includes(continuation.status)
    )
      return;
    yield* dispatchWithReceiptEffect({
      type: continuation.status === "queued" ? "queued-run.cancel" : "run.interrupt",
      commandId: CommandId.make(`limit-switch-withdraw:${continuation.id}`),
      threadId,
      runId: continuation.id,
    });
  });
  // Preserve the moved block's punctuation for the equivalence comparison.
  // prettier-ignore
  const retargetQueuedRuns = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (command.automaticProviderContinuationOfRunId !== undefined) {
      const projection = yield* getProjectionWithPendingEvents(command.threadId, events);
      const continuation = projection.runs.find(
        (run) => run.userMessageId === command.messageId,
      );
      if (continuation?.providerThreadId != null) {
        for (const event of usageLimitQueuedRunEvents(
          projection,
          continuation.providerThreadId,
          yield* DateTime.now,
        ))
          yield* emit(events, command)(event);
      }
    }
  });
  /**
   * A delegated child's result is held while its result run, or a run after it
   * that a restart cut before it started, still has recovery pending.
   */
  const childAwaitsRecoveryContinuation = (
    thread: OrchestrationV2AppThread,
    runs: ReadonlyArray<OrchestrationV2Run>,
    resultRun: OrchestrationV2Run,
    settledContinuationOf?: RunId,
  ) =>
    Effect.forEach(
      runs.filter(
        (run) =>
          run.id !== settledContinuationOf &&
          (run.id === resultRun.id || runRanAfter(run, resultRun)),
      ),
      awaitsRestartContinuation,
    ).pipe(
      Effect.flatMap((pending) =>
        Effect.gen(function* () {
          if (pending.includes(true)) return true;
          const latest = resultRun.status === "failed" ? resultRun : latestExecutedRun(runs);
          if (!latest || latest.status !== "failed") return false;
          const shell = yield* projectionStore.getThreadShell(thread.id);
          const { providerThreads, turnItems } = yield* projectionStore.getThreadRecords(
            thread.id,
            ["providerThreads", "turnItems"],
            { turnItemRunId: latest.id, turnItemTypes: ["error"] },
          );
          return usageLimitRecoveryPending(
            shell,
            latest,
            latestRootProviderFailure(latest, turnItems),
            runs,
            (yield* serverSettings.getSettings).usageLimitRecovery,
            providerThreads.find((providerThread) => providerThread.id === latest.providerThreadId)
              ?.driver,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
        }),
      ),
    );

  return {
    guardMutation,
    emitNotice,
    guardContinuation,
    continuedTaskId,
    queuedContinuationReleased,
    withdrawReleasedContinuation,
    retargetQueuedRuns,
    childAwaitsRecoveryContinuation,
  };
}
