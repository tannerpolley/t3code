import { CommandId, type ProviderThreadId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { threadIdleSinceMs } from "./ThreadIdleness.ts";

const MINUTE_MS = 60_000;
const SETTLED_SUBAGENT_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * One pass: disconnect every thread whose agent session sat idle past the
 * setting, and unload settled native subagents of threads still in use.
 */
export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sessions = yield* ProviderSessionManagerV2;
  // Subagent activity time at its last unload, so a subagent unloads once
  // per settled stretch rather than every pass.
  const unloadedSubagents = yield* Ref.make(new Map<ProviderThreadId, number>());

  const reapThread = Effect.fn("IdleSessionReaper.reapThread")(function* (
    threadId: ThreadId,
    thresholdMinutes: number,
    nowMs: number,
  ) {
    const records = yield* projections.getThreadRecords(threadId, [
      "providerSessions",
      "runs",
      "runtimeRequests",
      "subagents",
      "providerThreads",
    ]);
    if (
      !records.providerSessions.some(
        (session) => session.status !== "stopped" && session.status !== "error",
      )
    ) {
      return;
    }
    // A working thread is never touched, not even its settled subagents.
    const idleSinceMs = threadIdleSinceMs(records);
    if (idleSinceMs === null) return;
    // Provider background tasks (for example a Claude background Bash) outlive the run.
    const shell = yield* projections.getThreadShell(threadId);
    if ((shell?.pendingBackgroundTasks?.length ?? 0) > 0) return;
    if (nowMs - idleSinceMs < thresholdMinutes * MINUTE_MS) {
      // The thread stays connected, but a shared runtime (Codex) keeps each
      // settled native subagent loaded, MCP servers included, until unloaded.
      for (const subagent of records.subagents) {
        const providerThread = records.providerThreads.find(
          (candidate) => candidate.id === subagent.providerThreadId,
        );
        const activeAtMs = DateTime.toEpochMillis(subagent.completedAt ?? subagent.updatedAt);
        if (
          providerThread === undefined ||
          !SETTLED_SUBAGENT_STATUSES.has(subagent.status) ||
          nowMs - activeAtMs < thresholdMinutes * MINUTE_MS ||
          (yield* Ref.get(unloadedSubagents)).get(providerThread.id) === activeAtMs ||
          !(yield* sessions.unloadProviderThread(providerThread))
        ) {
          continue;
        }
        yield* Ref.update(unloadedSubagents, (current) =>
          new Map(current).set(providerThread.id, activeAtMs),
        );
        yield* Effect.logInfo("orchestration-v2.idle-session.subagent-unloaded", {
          threadId,
          providerThreadId: providerThread.id,
          idleMinutes: Math.floor((nowMs - activeAtMs) / MINUTE_MS),
        });
      }
      return;
    }
    // The same detach "Disconnect agent session" dispatches for each session.
    for (const session of records.providerSessions) {
      yield* threads.dispatch({
        type: "provider-session.detach",
        commandId: CommandId.make(`server:idle-disconnect:${threadId}:${nowMs}:${session.id}`),
        threadId,
        providerSessionId: session.id,
        reason: "idle-timeout",
        ifIdleSince: DateTime.makeUnsafe(idleSinceMs),
      });
    }
    yield* Effect.logInfo("orchestration-v2.idle-session.disconnected", {
      threadId,
      idleMinutes: Math.floor((nowMs - idleSinceMs) / MINUTE_MS),
    });
  });

  return Effect.fn("IdleSessionReaper.sweep")(function* () {
    const { idleAgentSessionMinutes } = yield* settings.getSettings;
    if (idleAgentSessionMinutes === 0) return;
    const nowMs = yield* Clock.currentTimeMillis;
    // Runtime recovery's thread set already includes every thread holding a live session.
    for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
      yield* reapThread(threadId, idleAgentSessionMinutes, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.idle-session.disconnect-failed", {
            threadId,
            cause,
          }),
        ),
      );
    }
  });
});

// Reads the setting on every pass, so changing it needs no restart. The shared
// scheduler ticks every few seconds; one pass a minute is plenty for minute thresholds.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    let nextSweepMs = 0;
    yield* scheduler.register(
      "idle-agent-session-reaper",
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs < nextSweepMs) return;
        nextSweepMs = nowMs + MINUTE_MS;
        yield* sweep();
      }),
    );
  }),
);
