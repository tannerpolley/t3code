import { CommandId, MessageId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { usageLimitSwitchTarget } from "./usageLimitSwitchTarget.ts";

export class UsageLimitProviderSwitchWorker extends Context.Service<
  UsageLimitProviderSwitchWorker,
  {
    readonly recover: (threadId: ThreadId) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/UsageLimitProviderSwitchWorker") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const lock = yield* Semaphore.make(1);
  const recover = Effect.fn("UsageLimitProviderSwitchWorker.recover")(
    function* (threadId: ThreadId) {
      const preferences = yield* settings.getSettings;
      if (preferences.usageLimitRecovery !== "switch") return;
      const shell = yield* projections.getThreadShell(threadId);
      if (
        !shell ||
        shell.status !== "failed" ||
        shell.lastErrorClass !== "usage_limit" ||
        !shell.latestRunId ||
        shell.archivedAt !== null ||
        shell.deletedAt !== null ||
        shell.settledOverride === "settled" ||
        shell.pendingRuntimeRequest !== null ||
        shell.snoozedUntil != null
      )
        return;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const identity = `${threadId}:${shell.latestRunId}`;
      let marker =
        shell.autoProviderSwitch?.runId === shell.latestRunId
          ? shell.autoProviderSwitch
          : undefined;
      if (marker === undefined) {
        const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
          runIds: [shell.latestRunId],
        });
        const failedRun = runs[0];
        if (
          thread.repositoryOrchestration?.retiredToThreadId !== undefined ||
          !failedRun ||
          !modelSelectionsEqual(failedRun.modelSelection, shell.modelSelection)
        )
          return;
        const snapshots = yield* providers.getProviders;
        const source = snapshots.find(
          (provider) => provider.instanceId === shell.modelSelection.instanceId,
        );
        if (source?.driver !== "codex" && source?.driver !== "claudeAgent") return;
        const previous = shell.autoProviderSwitch;
        const excludedTargets =
          previous?.switchBack !== undefined &&
          shell.modelSelection.instanceId !== previous.switchBack.instanceId &&
          (previous.resetAt === null || Date.parse(previous.resetAt) > nowMs)
            ? new Set([previous.switchBack.instanceId])
            : new Set<ProviderInstanceId>();
        const target = usageLimitSwitchTarget(
          shell,
          preferences,
          snapshots,
          new Set(yield* adapters.list()),
          nowMs,
          excludedTargets,
        );
        marker = {
          runId: shell.latestRunId,
          from: shell.modelSelection,
          ...(target !== null || previous?.switchBack !== undefined || previous?.to != null
            ? { switchBack: previous?.switchBack ?? previous?.from ?? shell.modelSelection }
            : {}),
          to: target,
          resetAt: shell.usageLimitResetAt ?? null,
          message:
            target === null
              ? "No alternative provider is available. Waiting for the usage limit to reset."
              : `Switched automatically from ${source.displayName ?? source.instanceId} (${shell.modelSelection.model}) to ${snapshots.find((provider) => provider.instanceId === target.instanceId)?.displayName ?? target.instanceId} (${target.model}) after a usage limit.`,
        };
        if (target === null) {
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`limit-switch-unavailable:${identity}`),
            threadId,
            autoProviderSwitch: marker,
          });
        } else {
          const switched = yield* threads
            .dispatch({
              type: "provider.switch",
              commandId: CommandId.make(`limit-switch:${identity}`),
              threadId,
              modelSelection: target,
              autoProviderSwitch: marker,
            })
            .pipe(Effect.result);
          if (switched._tag === "Failure") {
            // A raced user action fails the guarded marker too; never switch it back.
            marker = {
              ...marker,
              to: null,
              message:
                "The alternative provider could not be selected. Waiting for the usage limit to reset.",
            };
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`limit-switch-unavailable:${identity}`),
              threadId,
              autoProviderSwitch: marker,
            });
          }
        }
      }
      if (marker.to === null) {
        const current = yield* projections.getThreadShell(threadId);
        if (!current) return;
        const arm = limitRecoveryCommand(current, true, nowMs, true);
        if (arm?.type === "thread.metadata.update") yield* threads.dispatch(arm);
        // A terminal decision without a schedulable reset releases the child's failure.
        yield* orchestrator.recoverDelegatedTask(threadId, marker.runId);
        return;
      }
      const current = yield* projections.getThread(threadId);
      if (!modelSelectionsEqual(current.modelSelection, marker.to)) return;
      // Stable per failed run, including recovery after a crash between switching and continuing.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`limit-switch-resume:${identity}`),
        messageId: MessageId.make(`limit-switch-resume:${identity}`),
        threadId,
        automaticProviderContinuationOfRunId: marker.runId,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
    },
    (effect) => lock.withPermits(1)(effect),
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.limit-provider-switch.failed", { cause }),
    ),
  );
  const sweep = Effect.gen(function* () {
    if ((yield* settings.getSettings).usageLimitRecovery !== "switch") return;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now: yield* DateTime.now,
      autoResume: false,
      snooze: false,
      switchProvider: true,
      switchProviderInstanceIds: (yield* providers.getProviders)
        .filter((provider) => provider.driver === "codex" || provider.driver === "claudeAgent")
        .map((provider) => provider.instanceId),
    });
    for (const candidate of candidates) yield* recover(candidate.id);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.limit-provider-switch.sweep-failed", { cause }),
    ),
  );
  return UsageLimitProviderSwitchWorker.of({ recover, sweep });
});

export const layer = Layer.effect(UsageLimitProviderSwitchWorker, make);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* UsageLimitProviderSwitchWorker;
    const sink = yield* EventSink.EventSinkV2;
    const scheduler = yield* Scheduler.Scheduler;
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    yield* scheduler.register("usage-limit-provider-switch", worker.sweep);
    // Subscribe from a committed sequence before activation. The scheduler also recovers missed/restarted work.
    yield* forkParked(
      Stream.merge(
        sink.stream({ afterSequence, eventType: "run.updated" }),
        sink.stream({ afterSequence, eventType: "turn-item.updated" }),
      ).pipe(
        Stream.runForEach(({ event }) =>
          (event.type === "run.updated" && event.payload.status === "failed") ||
          (event.type === "turn-item.updated" &&
            event.payload.type === "error" &&
            event.payload.failure.class === "usage_limit")
            ? worker.recover(event.threadId)
            : Effect.void,
        ),
      ),
    );
  }),
);
