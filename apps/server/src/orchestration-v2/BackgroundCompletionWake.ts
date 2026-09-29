import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  heldBackgroundWork,
  type PendingBackgroundWorkTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

/**
 * How long a provider gets to wake its agent itself. Claude's own wake turn shows its first
 * frame within about 45 seconds (p99 23 s over the 2026-09 logs); Codex offers its continuation
 * at once.
 */
export const BACKGROUND_WAKE_GRACE = Duration.seconds(90);

const BACKGROUND_ITEM_TYPES = new Set(["command_execution", "dynamic_tool", "subagent"]);
const LIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const RESTART_RECONCILE_PREFIX = "command:runtime-reconcile:startup:";

interface OwedWake {
  /** When the first task of this batch was seen finished. */
  readonly since: number;
  readonly restart: boolean;
  readonly tasks: Array<PendingBackgroundWorkTask>;
}

export function backgroundWakeText(
  tasks: ReadonlyArray<PendingBackgroundWorkTask>,
  restart: boolean,
): { readonly text: string; readonly summary: string } {
  const names = tasks.map((task) => `"${task.description ?? task.taskId}" (${task.taskId})`);
  const subject =
    tasks.length === 1 ? `Background task ${names[0]}` : `Background tasks ${names.join(", ")}`;
  const verb = tasks.length === 1 ? "is" : "are";
  return restart
    ? {
        text: `${subject} stopped when T3 restarted. Check whether ${tasks.length === 1 ? "it" : "they"} finished, and start ${tasks.length === 1 ? "it" : "them"} again if you still need ${tasks.length === 1 ? "it" : "them"}.`,
        summary:
          tasks.length === 1
            ? "Background task stopped by a restart"
            : `${tasks.length} background tasks stopped by a restart`,
      }
    : {
        text: `${subject} ${verb} no longer running. Check the output and continue.`,
        summary:
          tasks.length === 1
            ? "Background task finished"
            : `${tasks.length} background tasks finished`,
      };
}

/**
 * Safety net for background work that stops while its agent is idle. The provider normally
 * wakes the agent itself (a Claude wake turn, a Codex completion continuation). When no run
 * follows within BACKGROUND_WAKE_GRACE, the provider's signal was missed or lost with its
 * session, so this dispatches the wake as a queued server notification carrying every task that
 * finished in the window. The command id is keyed by the first finished task, so a replayed
 * event finds the earlier receipt instead of waking twice, and only a task finishing (never the
 * wake itself) schedules one. A thread whose user stopped its background work, or a watcher-only
 * monitor, owes no wake.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const threads = yield* ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const scope = yield* Effect.scope;
    // Held work each idle thread was last seen waiting on, and wakes waiting out the grace.
    const waitingOn = new Map<ThreadId, ReadonlyArray<PendingBackgroundWorkTask>>();
    const owedWakes = new Map<ThreadId, OwedWake>();

    const fire = Effect.fn("BackgroundCompletionWake.fire")(function* (threadId: ThreadId) {
      const owed = owedWakes.get(threadId);
      owedWakes.delete(threadId);
      const first = owed?.tasks[0];
      if (owed === undefined || first === undefined) return;
      const records = yield* threads.getThreadRecords(threadId, ["runs", "subagents"]);
      const { thread } = records;
      if (thread.archivedAt !== null || thread.deletedAt !== null || thread.settledAt !== null) {
        return;
      }
      // The provider (or the user) already woke the agent.
      if (
        records.runs.some(
          (run) =>
            LIVE_RUN_STATUSES.has(run.status) ||
            DateTime.toEpochMillis(run.requestedAt) >= owed.since,
        )
      ) {
        return;
      }
      // A native subagent still working in this session hears its own shells finish.
      if (records.subagents.some((subagent) => isOrchestrationV2WorkActive(subagent.status))) {
        return;
      }
      if (owed.restart) {
        const current = yield* settings.getSettings;
        if (
          !resolveProjectSettings(current, thread.projectId).settings
            .continueThreadsAfterServerUpdate
        ) {
          return;
        }
      }
      const { text, summary } = backgroundWakeText(owed.tasks, owed.restart);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:background-wake:${threadId}:${first.taskId}`),
        threadId,
        messageId: MessageId.make(`message:background-wake:${threadId}:${first.taskId}`),
        text,
        notification: {
          source: { kind: "background_task" },
          outcome: owed.restart ? "cancelled" : "updated",
          summary,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* Effect.logInfo("orchestration-v2.background-wake.dispatched", {
        threadId,
        taskIds: owed.tasks.map((task) => task.taskId),
        restart: owed.restart,
      });
    });

    // Compares the thread's held work with what it was last seen waiting on. Called serially.
    const check = Effect.fn("BackgroundCompletionWake.check")(function* (
      threadId: ThreadId,
      atMs: number,
      restart: boolean,
    ) {
      const shell = yield* projections.getThreadShell(threadId);
      const previous = waitingOn.get(threadId) ?? [];
      // A live turn hears its own background work finish; the shell lists none while one runs.
      const awake =
        shell === null ||
        (shell.activityRunStatus !== undefined &&
          shell.activityRunStatus !== null &&
          shell.activityRunStatus !== "waiting");
      const current = awake ? [] : heldBackgroundWork(shell.pendingBackgroundTasks);
      if (current.length > 0) waitingOn.set(threadId, current);
      else waitingOn.delete(threadId);
      if (awake) return;
      const finished = previous.filter(
        (task) => !current.some((candidate) => candidate.taskId === task.taskId),
      );
      if (finished.length === 0) return;
      const owed = owedWakes.get(threadId);
      if (owed !== undefined) {
        owed.tasks.push(...finished);
        return;
      }
      owedWakes.set(threadId, { since: atMs, restart, tasks: [...finished] });
      yield* Effect.sleep(BACKGROUND_WAKE_GRACE).pipe(
        Effect.andThen(fire(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.background-wake.failed", { threadId, cause }),
        ),
        Effect.forkIn(scope),
      );
    });

    const handle = (stored: OrchestrationV2StoredEvent) => {
      const { event } = stored;
      const threadId = event.threadId;
      if (event.type === "turn-item.updated") {
        // The user stopped this thread's background work: nothing to report back.
        if (event.payload.type === "run_interrupt_request") {
          waitingOn.delete(threadId);
          owedWakes.delete(threadId);
          return Effect.void;
        }
        if (!BACKGROUND_ITEM_TYPES.has(event.payload.type) || !waitingOn.has(threadId)) {
          return Effect.void;
        }
      } else if (
        event.type === "provider-thread.updated" &&
        !waitingOn.has(threadId) &&
        heldBackgroundWork(event.payload.pendingBackgroundTasks).length === 0
      ) {
        return Effect.void;
      }
      return check(
        threadId,
        DateTime.toEpochMillis(event.occurredAt),
        String(stored.commandId).startsWith(RESTART_RECONCILE_PREFIX),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.background-wake.check-failed", { threadId, cause }),
        ),
      );
    };

    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    // Work that was running when the server stopped: startup recovery clears it after this.
    const seedThreadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(Effect.orElseSucceed(() => []));
    for (const threadId of seedThreadIds) {
      yield* Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        const held = heldBackgroundWork(shell?.pendingBackgroundTasks);
        if (held.length === 0) return;
        // A roster left behind by a session the user already disconnected died with it.
        const { providerSessions } = yield* threads.getThreadRecords(threadId, [
          "providerSessions",
        ]);
        if (
          providerSessions.some(
            (session) => session.status !== "stopped" && session.status !== "error",
          )
        ) {
          waitingOn.set(threadId, held);
        }
      }).pipe(Effect.ignore);
    }
    yield* Stream.mergeAll(
      [
        eventSink.stream({ afterSequence, eventType: "run.updated" }),
        eventSink.stream({ afterSequence, eventType: "provider-thread.updated" }),
        eventSink.stream({ afterSequence, eventType: "turn-item.updated" }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Stream.runForEach(handle), Effect.forkScoped);
  }),
);
