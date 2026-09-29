import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionStoreV2, type ProjectionTitleRefreshCandidate } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { TITLE_REFRESH_MODEL_SELECTION } from "./ThreadTitleRegenerationService.ts";

const MINUTE_MS = 60_000;
/** A thread's title is re-evaluated at most this often, and only after new messages. */
export const TITLE_REFRESH_INTERVAL_MS = 10 * MINUTE_MS;
/** A sweep starts refreshes only while fewer regenerations than this are pending in its read. */
const MAX_IN_FLIGHT = 2;

/**
 * Generated titles due for a refresh, most overdue first. A sweep admits at most
 * MAX_IN_FLIGHT minus the regenerations pending in the same read; nothing else limits
 * manual or first-message regenerations. `fallbackEvaluatedAtMs` stands in for threads never
 * evaluated since this feature shipped, so only messages after it count as new.
 */
export function selectTitleRefreshThreads(
  candidates: ReadonlyArray<ProjectionTitleRefreshCandidate>,
  options: { readonly nowMs: number; readonly fallbackEvaluatedAtMs: number },
): ReadonlyArray<ProjectionTitleRefreshCandidate["thread"]> {
  // A marker older than the interval is stuck (its worker died); it should not block the rest.
  const inFlight = candidates.filter(
    ({ thread }) =>
      thread.titleRegeneration != null &&
      options.nowMs - DateTime.toEpochMillis(thread.titleRegeneration.startedAt) <
        TITLE_REFRESH_INTERVAL_MS,
  ).length;
  return candidates
    .flatMap(({ thread, latestMessageAt }) => {
      if (
        thread.titleSource === "user" ||
        thread.titleRegeneration != null ||
        latestMessageAt === null
      ) {
        return [];
      }
      const evaluatedAtMs = thread.titleEvaluation
        ? Date.parse(thread.titleEvaluation.evaluatedAt)
        : options.fallbackEvaluatedAtMs;
      return Date.parse(latestMessageAt) > evaluatedAtMs &&
        options.nowMs - evaluatedAtMs >= TITLE_REFRESH_INTERVAL_MS
        ? [{ thread, evaluatedAtMs }]
        : [];
    })
    .toSorted((left, right) => left.evaluatedAtMs - right.evaluatedAtMs)
    .slice(0, Math.max(0, MAX_IN_FLIGHT - inFlight))
    .map(({ thread }) => thread);
}

/** One pass: arm the regular title regeneration for each due thread. */
export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const startedAtMs = yield* Clock.currentTimeMillis;

  return Effect.fn("ThreadTitleRefresh.sweep")(function* () {
    if (!(yield* settings.getSettings).keepThreadTitlesCurrent) return;
    // Refresh only runs on its own cheap model; without Codex it waits rather than falling back.
    const codex = yield* providers.getInstance(TITLE_REFRESH_MODEL_SELECTION.instanceId);
    if (codex?.enabled !== true) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const candidates = yield* projections.getTitleRefreshCandidates({
      evaluatedBefore: DateTime.formatIso(DateTime.makeUnsafe(nowMs - TITLE_REFRESH_INTERVAL_MS)),
      fallbackEvaluatedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
    });
    const due = selectTitleRefreshThreads(candidates, {
      nowMs,
      fallbackEvaluatedAtMs: startedAtMs,
    });
    for (const thread of due) {
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:title-refresh:${thread.id}:${nowMs}`),
          threadId: thread.id,
          regenerateTitle: true,
          // A rename or a manual Regenerate landing after the read above wins.
          titleRefreshGuard: {
            title: thread.title,
            evaluationRequestId: thread.titleEvaluation?.requestId ?? null,
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.title-refresh.dispatch-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
    }
  });
});

// Passes run about once a minute with jitter; each thread's own ten-minute marker and the
// per-sweep admission cap spread the model calls out. The setting is read every pass.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    let nextSweepMs = (yield* Clock.currentTimeMillis) + MINUTE_MS;
    yield* scheduler.register(
      "thread-title-refresh",
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs < nextSweepMs) return;
        nextSweepMs = nowMs + MINUTE_MS + (yield* Random.nextIntBetween(0, 30_000));
        yield* sweep();
      }),
    );
  }),
);
