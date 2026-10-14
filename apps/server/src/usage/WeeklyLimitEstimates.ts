/** Current per-instance weekly factors, published through provider snapshots rather than threads. */
import { UsageDay, type ServerProvider, type UsageProviderKind } from "@t3tools/contracts";
import { isUsageWindowStale, weeklyLimitPercentPerUsd } from "@t3tools/shared/forkUsageLimits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { backfillThreadUsageCosts } from "../orchestration-v2/ThreadUsageSummary.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { UsageService } from "./UsageService.ts";

export class WeeklyLimitEstimates extends Context.Service<
  WeeklyLimitEstimates,
  {
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
>()("t3/usage/WeeklyLimitEstimates") {}

const ESTIMATED_PROVIDERS: Partial<Record<string, UsageProviderKind>> = {
  codex: "codex",
  claudeAgent: "claude",
};
const DAY_MS = 24 * 60 * 60_000;

function weeklyWindows(snapshots: ReadonlyArray<ServerProvider>) {
  return snapshots.flatMap((provider) => {
    const kind = ESTIMATED_PROVIDERS[provider.driver];
    const window = provider.usageLimits?.windows.find((entry) => entry.kind === "weekly");
    // Scans aggregate accounts by kind. Without account attribution, even an instance that
    // cannot report its own window could contaminate the denominator of another account.
    return kind === undefined ||
      window === undefined ||
      snapshots.filter((p) => p.driver === provider.driver).length !== 1
      ? []
      : [
          {
            instanceId: provider.instanceId,
            kind,
            window,
            key: JSON.stringify([
              provider.auth,
              provider.usageLimits?.credentialFingerprint,
              window,
            ]),
          },
        ];
  });
}

type Factors = ReadonlyMap<string, { readonly key: string; readonly percentPerUsd: number }>;

const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry;
  const usage = yield* UsageService;
  const factors = yield* SubscriptionRef.make<Factors>(new Map());
  // Complete the upgrade before clients can load their initial shell snapshot.
  yield* backfillThreadUsageCosts;

  const refresh = Effect.gen(function* () {
    const snapshots = yield* providers.getProviders;
    const windows = weeklyWindows(snapshots);
    const nowMs = yield* Clock.currentTimeMillis;
    const next = new Map<string, { readonly key: string; readonly percentPerUsd: number }>();
    if (windows.length > 0) {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const day = (ms: number) => UsageDay.make(formatter.format(ms));
      const summary = yield* usage.readSummary({
        sinceDay: day(nowMs - 8 * DAY_MS),
        untilDay: day(nowMs),
        timeZone,
      });
      for (const { instanceId, kind, window, key } of windows) {
        const factor = weeklyLimitPercentPerUsd({
          window,
          buckets: summary.buckets,
          provider: kind,
          nowMs,
          timeZone,
        });
        if (factor !== null) next.set(instanceId, { key, percentPerUsd: factor });
      }
    }
    yield* SubscriptionRef.set(factors, next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage.weekly-limit-estimates.refresh-failed", { cause }),
    ),
  );

  // Always read the latest registry snapshot. A reset inside the interval is applied on the
  // next tick even if the provider never changes that reading again.
  yield* refresh.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped);

  const decorate = (snapshots: ReadonlyArray<ServerProvider>, current: Factors, nowMs: number) => {
    const windows = weeklyWindows(snapshots);
    return snapshots.map((provider) => {
      const weekly = windows.find((entry) => entry.instanceId === provider.instanceId);
      const factor = current.get(provider.instanceId);
      if (
        weekly === undefined ||
        factor?.key !== weekly.key ||
        isUsageWindowStale(weekly.window, nowMs)
      )
        return provider;
      return {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          windows: provider.usageLimits!.windows.map((window) =>
            window === weekly.window
              ? { ...window, weeklyLimitPercentPerUsd: factor.percentPerUsd }
              : window,
          ),
        },
      };
    });
  };
  return WeeklyLimitEstimates.of({
    getProviders: Effect.gen(function* () {
      return decorate(
        yield* providers.getProviders,
        yield* SubscriptionRef.get(factors),
        yield* Clock.currentTimeMillis,
      );
    }),
    streamChanges: Stream.zipLatestWith(
      Stream.concat(Stream.fromEffect(providers.getProviders), providers.streamChanges),
      SubscriptionRef.changes(factors),
      (snapshots, current) => ({ snapshots, current }),
    ).pipe(
      Stream.mapEffect(({ snapshots, current }) =>
        Clock.currentTimeMillis.pipe(Effect.map((nowMs) => decorate(snapshots, current, nowMs))),
      ),
    ),
  });
});

export const layer = Layer.effect(WeeklyLimitEstimates, make);
