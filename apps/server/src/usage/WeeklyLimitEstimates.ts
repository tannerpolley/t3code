/**
 * WeeklyLimitEstimates — how much of a provider's weekly limit a thread has spent, for the
 * sidebar's usage cell.
 *
 * Providers report only a whole account's weekly percent. The Usage page already prices the
 * scanned transcripts like the API would, so the window's reported percent over its priced cost
 * gives a "percent per dollar" factor for each provider instance. A thread's own tokens, priced
 * the same way, times that factor is its estimated share. The factor refreshes when provider
 * limits do, at most every few minutes; thread summaries read the latest one when their own usage
 * changes.
 *
 * @module usage/WeeklyLimitEstimates
 */
import {
  UsageDay,
  type ServerProvider,
  type UsageProviderKind,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import { weeklyLimitPercentPerUsd } from "@t3tools/shared/forkUsageLimits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { type TokenPricer, UsageService } from "./UsageService.ts";

/** What a thread's estimate needs: the shared pricer and each instance's factor. */
export interface WeeklyLimitEstimateInputs {
  readonly priceTokens: TokenPricer;
  /** Percent of each provider instance's weekly limit that one dollar of usage spends. */
  readonly percentPerUsd: ReadonlyMap<string, number>;
}

// ponytail: one process-wide default, so the projection store and the updater share it without
// new layer wiring; a test overrides it with its own value.
const sharedEstimates: { current: WeeklyLimitEstimateInputs | null } = { current: null };

export class WeeklyLimitEstimates extends Context.Reference<{
  current: WeeklyLimitEstimateInputs | null;
}>("t3/usage/WeeklyLimitEstimates", { defaultValue: () => sharedEstimates }) {}

/** One model's tokens on one provider instance across a thread's turns. */
export interface ThreadModelTokens {
  readonly instanceId: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
}

/**
 * A thread's API-equivalent cost on its current provider instance and the share of that
 * instance's weekly limit it spent. Undefined without inputs, without tokens on the instance, or
 * when any of its models has no price, since a partial cost would understate the share. The share
 * is left out while the instance's factor is unknown.
 */
export function threadWeeklyLimitEstimate(
  rows: readonly ThreadModelTokens[],
  instanceId: string,
  inputs: WeeklyLimitEstimateInputs | null,
): { readonly costUsd: number; readonly weeklyLimitPercent?: number } | undefined {
  if (inputs === null) return undefined;
  let costUsd = 0;
  let priced = false;
  for (const row of rows) {
    if (row.instanceId !== instanceId) continue;
    const cost = inputs.priceTokens(row.model, row.totals);
    if (cost === null) return undefined;
    costUsd += cost;
    priced = true;
  }
  if (!priced) return undefined;
  const factor = inputs.percentPerUsd.get(instanceId);
  return factor === undefined ? { costUsd } : { costUsd, weeklyLimitPercent: costUsd * factor };
}

/** Drivers whose weekly limit and transcripts the estimate covers. */
const ESTIMATED_PROVIDERS: Partial<Record<string, UsageProviderKind>> = {
  codex: "codex",
  claudeAgent: "claude",
};
/** Limits refresh often while clients focus; each estimate refresh rescans a week of history. */
const MIN_REFRESH_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function weeklyWindows(snapshots: ReadonlyArray<ServerProvider>) {
  return snapshots.flatMap((provider) => {
    const kind = ESTIMATED_PROVIDERS[provider.driver];
    const window = provider.usageLimits?.windows.find((entry) => entry.kind === "weekly");
    return kind === undefined || window === undefined
      ? []
      : [{ instanceId: provider.instanceId, kind, window }];
  });
}

/** Recomputes the factors when Codex or Claude weekly limits change, from an incremental scan. */
export const layerUpdater = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry;
    const usage = yield* UsageService;
    const estimates = yield* WeeklyLimitEstimates;
    let lastRefreshMs = Number.NEGATIVE_INFINITY;

    const refresh = Effect.fn("WeeklyLimitEstimates.refresh")(function* (
      snapshots: ReadonlyArray<ServerProvider>,
    ) {
      const windows = weeklyWindows(snapshots);
      const nowMs = yield* Clock.currentTimeMillis;
      // ponytail: a change inside the interval waits for the next limits refresh to be counted.
      if (windows.length === 0 || nowMs - lastRefreshMs < MIN_REFRESH_INTERVAL_MS) return;
      lastRefreshMs = nowMs;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const day = (ms: number) =>
        UsageDay.make(
          new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(ms),
        );
      // A weekly window can open just before local midnight eight days ago.
      const summary = yield* usage.readSummary({
        sinceDay: day(nowMs - 8 * DAY_MS),
        untilDay: day(nowMs),
        timeZone,
      });
      const priceTokens = yield* usage.tokenPricer;
      const percentPerUsd = new Map<string, number>();
      for (const { instanceId, kind, window } of windows) {
        const factor = weeklyLimitPercentPerUsd({
          window,
          buckets: summary.buckets,
          provider: kind,
          nowMs,
          timeZone,
        });
        if (factor !== null) percentPerUsd.set(instanceId, factor);
      }
      estimates.current = { priceTokens, percentPerUsd };
    });
    const refreshLogged = (snapshots: ReadonlyArray<ServerProvider>) =>
      refresh(snapshots).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage.weekly-limit-estimates.refresh-failed", { cause }),
        ),
      );

    yield* providers.getProviders.pipe(Effect.flatMap(refreshLogged), Effect.forkScoped);
    yield* providers.streamChanges.pipe(
      // Only a new reading of a Codex or Claude weekly limit changes the factors.
      Stream.map((snapshots) => ({
        snapshots,
        key: JSON.stringify(
          weeklyWindows(snapshots).map(({ instanceId, window }) => [
            instanceId,
            window.usedPercent,
            window.resetsAt,
          ]),
        ),
      })),
      Stream.changesWith((left, right) => left.key === right.key),
      Stream.runForEach(({ snapshots }) => refreshLogged(snapshots)),
      Effect.forkScoped,
    );
  }),
);
