import { assert, it } from "@effect/vitest";
import { ServerProvider, UsageDay, type UsageBucket } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { UsageService } from "./UsageService.ts";
import * as WeeklyLimitEstimates from "./WeeklyLimitEstimates.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

const provider = (instanceId = "codex", usedPercent = 10) =>
  decodeProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "1970-01-01T00:00:00.000Z",
    models: [],
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00.000Z",
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: "1970-01-07T00:00:00.000Z",
          windowDurationMins: 7 * 24 * 60,
        },
      ],
    },
  });
const bucket: UsageBucket = {
  day: UsageDay.make("1969-12-31"),
  provider: "codex",
  model: "priced",
  totals: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 10_000,
    reasoningTokens: 0,
  },
  costUsd: 10,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
};
const testLayer = (snapshots: SubscriptionRef.SubscriptionRef<ReadonlyArray<ServerProvider>>) =>
  WeeklyLimitEstimates.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry)({
        getProviders: SubscriptionRef.get(snapshots),
        streamChanges: SubscriptionRef.changes(snapshots),
      }),
    ),
    Layer.provide(
      Layer.mock(UsageService)({
        tokenPricer: Effect.succeed(() => null),
        readSummary: (input) =>
          Effect.succeed({
            contractVersion: 1,
            readAt: "1970-01-01T00:00:00.000Z",
            ...input,
            buckets: [bucket],
            sources: [],
            pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 0,
          }),
      }),
    ),
    Layer.provide(SqlitePersistence.layerMemory),
  );
const factor = (snapshot: ServerProvider | undefined) =>
  snapshot?.usageLimits?.windows[0]?.weeklyLimitPercentPerUsd;
const awaitFactor = (
  service: WeeklyLimitEstimates.WeeklyLimitEstimates["Service"],
  expected: number,
) =>
  service.streamChanges.pipe(
    Stream.filter((snapshots) => factor(snapshots[0]) === expected),
    Stream.take(1),
    Stream.runCollect,
  );

it.effect("withholds both account estimates when their scanned costs share a provider kind", () =>
  Effect.gen(function* () {
    const snapshots = yield* SubscriptionRef.make<ReadonlyArray<ServerProvider>>([
      provider("a", 10),
      provider("b", 90),
    ]);
    yield* Effect.gen(function* () {
      const service = yield* WeeklyLimitEstimates.WeeklyLimitEstimates;
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual((yield* service.getProviders).map(factor), [undefined, undefined]);
      yield* SubscriptionRef.set(snapshots, [provider("a", 10)]);
      yield* TestClock.adjust("5 minutes");
      yield* awaitFactor(service, 1);
      assert.equal(factor((yield* service.getProviders)[0]), 1);
    }).pipe(Effect.provide(testLayer(snapshots)));
  }).pipe(Effect.scoped),
);

it.effect("applies the last reading after the interval without another provider change", () =>
  Effect.gen(function* () {
    const snapshots = yield* SubscriptionRef.make<ReadonlyArray<ServerProvider>>([provider()]);
    yield* Effect.gen(function* () {
      const service = yield* WeeklyLimitEstimates.WeeklyLimitEstimates;
      yield* awaitFactor(service, 1);
      yield* TestClock.adjust("1 minute");
      // A reset/redeemed credit changes the reading once, inside the old throttle interval.
      yield* SubscriptionRef.set(snapshots, [provider("codex", 2)]);
      assert.isUndefined(factor((yield* service.getProviders)[0]));
      const updated = yield* awaitFactor(service, 0.2).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 minutes");
      yield* Fiber.join(updated);
      assert.equal(factor((yield* service.getProviders)[0]), 0.2);
    }).pipe(Effect.provide(testLayer(snapshots)));
  }).pipe(Effect.scoped),
);
