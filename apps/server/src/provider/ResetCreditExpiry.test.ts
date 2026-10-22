import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  UsageLimitSourceId,
  UsageLimitSourceError,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceConsumeResetCreditInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ResetCreditAutoUseResult,
  type ProviderConsumeResetCreditOutcome,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderDriverError } from "./Errors.ts";
import * as ResetCreditExpiry from "./ResetCreditExpiry.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import {
  makeResetCreditExpiryResults,
  resetCreditAccountKey,
  makeSourceResetCreditExpiryResults,
  resetCreditSourceAccountKey,
} from "./ResetCreditExpiryResults.ts";

const MINUTE = 60_000;
const decodeProvider = Schema.decodeSync(ServerProvider);
const provider = (expiresAt: number, instanceId = "codex", creditId = "credit-a") =>
  decodeProvider({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    checkedAt: "1970-01-01T00:00:00.000Z",
    models: [],
    auth: { status: "authenticated", email: "account@example.com" },
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00.000Z",
      windows: [],
      resetCredits: {
        availableCount: 1,
        nextCreditId: creditId,
        expiries: [DateTime.formatIso(DateTime.makeUnsafe(expiresAt))],
      },
    },
  });

const fixture = Effect.fn("ResetCreditExpiryTest.fixture")(function* (
  input: {
    readonly providers?: readonly ServerProvider[];
    readonly sources?: readonly UsageLimitSourceSnapshot[];
    readonly failures?: number;
    readonly outcome?: ProviderConsumeResetCreditOutcome;
  } = {},
) {
  const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
  const snapshots = yield* Ref.make<readonly ServerProvider[]>(
    input.providers ?? [provider(20 * MINUTE)],
  );
  const updates = yield* PubSub.unbounded<readonly ServerProvider[]>();
  const ready = yield* Deferred.make<void>();
  const enabled = yield* Ref.make(true);
  const calls = yield* Ref.make<
    readonly { creditId: string | undefined; key: string; at: number }[]
  >([]);
  const results = yield* Queue.unbounded<ResetCreditAutoUseResult>();
  const queued = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const subscription = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(updates);
      yield* Deferred.succeed(ready, undefined);
      return Stream.concat(Stream.fromEffect(Ref.get(snapshots)), Stream.fromSubscription(changes));
    }),
  );
  const instance = (value: ServerProvider): ProviderInstance => ({
    instanceId: value.instanceId,
    driverKind: value.driver,
    enabled: true,
    displayName: undefined,
    continuationIdentity: { driverKind: value.driver, continuationKey: value.instanceId },
    snapshot: {
      getSnapshot: Ref.get(snapshots).pipe(
        Effect.map((all) => all.find((p) => p.instanceId === value.instanceId)!),
      ),
    } as ProviderInstance["snapshot"],
    consumeResetCredit: (expected, canRedeem) =>
      Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          coordinator
            .redeem("shared-account", (key) =>
              Effect.gen(function* () {
                if (canRedeem && !(yield* canRedeem)) return "nothingToReset" as const;
                const at = yield* Clock.currentTimeMillis;
                const seen = yield* Ref.updateAndGet(calls, (previous) => [
                  ...previous,
                  { creditId: expected?.creditId, key, at },
                ]);
                if (seen.length <= (input.failures ?? 0))
                  return yield* Effect.fail("transient" as const);
                return input.outcome ?? "reset";
              }),
            )
            .pipe(
              Effect.tap(() => Deferred.succeed(completed, undefined)),
              Effect.tapError(() => Deferred.succeed(completed, undefined)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: value.driver,
                    instanceId: value.instanceId,
                    detail: "Could not redeem.",
                    cause,
                  }),
              ),
            ),
        ),
      ),
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  });
  const sourceSnapshots = input.sources ?? [];
  const sourceInputs = yield* Ref.make<readonly UsageLimitSourceConsumeResetCreditInput[]>([]);
  const deps = Layer.mergeAll(
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed(sourceSnapshots),
      streamChanges: Stream.make(sourceSnapshots),
      consumeResetCredit: (creditInput, canRedeem) =>
        Ref.update(sourceInputs, (previous) => [...previous, creditInput]).pipe(
          Effect.andThen(
            instance(provider(20 * MINUTE)).consumeResetCredit!(
              { creditId: creditInput.creditId },
              canRedeem,
            ),
          ),
          Effect.map((outcome) => ({ outcome })),
          Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not redeem." })),
        ),
      publishResetCreditAutoUse: (_sourceId, _accountId, _accountKey, result) =>
        Queue.offer(results, result).pipe(Effect.asVoid),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Ref.get(snapshots),
      subscribeChanges: Effect.succeed(subscription),
      publishResetCreditAutoUse: (_instanceId, _account, result) =>
        Queue.offer(results, result).pipe(Effect.asVoid),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) =>
        Ref.get(snapshots).pipe(
          Effect.map((all) => {
            const value = all.find((p) => p.instanceId === id);
            return value ? instance(value) : undefined;
          }),
        ),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Ref.get(enabled).pipe(
        Effect.map((autoUseExpiringResetCredits) => ({
          ...DEFAULT_SERVER_SETTINGS,
          autoUseExpiringResetCredits,
        })),
      ),
    }),
  );
  const service = yield* ResetCreditExpiry.ResetCreditExpiry.pipe(
    Effect.provide(ResetCreditExpiry.layer.pipe(Layer.provide(deps))),
  );
  yield* service.start;
  yield* Deferred.await(ready);
  const update = Effect.fn("ResetCreditExpiryTest.update")(function* (
    values: readonly ServerProvider[],
  ) {
    yield* Ref.set(snapshots, values);
    yield* PubSub.publish(updates, values);
  });
  return { calls, results, enabled, update, sourceInputs, queued, completed };
});

const test = (
  program: Effect.Effect<
    void,
    never,
    import("effect/Scope").Scope | ResetCreditCoordinator.ResetCreditCoordinator
  >,
) => program.pipe(Effect.scoped, Effect.provide(ResetCreditCoordinator.layerTest));

describe("banked reset auto-use", () => {
  it.effect(
    "redeems at ten minutes through the coordinator and pins the credit only once across instances and updates",
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture({
            providers: [provider(20 * MINUTE), provider(20 * MINUTE, "second")],
          });
          yield* TestClock.adjust(10 * MINUTE - 1);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
          yield* TestClock.adjust(1);
          assert.strictEqual((yield* Queue.take(f.results)).status, "used");
          yield* f.update([provider(20 * MINUTE), provider(20 * MINUTE, "second")]);
          yield* TestClock.adjust(10 * MINUTE);
          const calls = yield* Ref.get(f.calls);
          assert.strictEqual(calls.length, 1);
          assert.strictEqual(calls[0]?.creditId, "credit-a");
          assert.strictEqual(calls[0]?.at, 10 * MINUTE);
        }),
      ),
  );

  it.effect(
    "retries transient errors every minute using the same coordinator idempotency key",
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture({ failures: 2 });
          yield* TestClock.adjust(12 * MINUTE);
          assert.strictEqual((yield* Queue.take(f.results)).status, "used");
          const calls = yield* Ref.get(f.calls);
          assert.deepStrictEqual(
            calls.map((call) => call.at),
            [10, 11, 12].map((minute) => minute * MINUTE),
          );
          assert.strictEqual(new Set(calls.map((call) => call.key)).size, 1);
        }),
      ),
  );

  it.effect("stops retries one minute before expiry and publishes failure", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture({ outcome: "nothingToReset" });
        yield* TestClock.adjust(25 * MINUTE);
        assert.strictEqual((yield* Queue.take(f.results)).status, "failed");
        const calls = yield* Ref.get(f.calls);
        assert.strictEqual(calls.length, 10);
        assert.strictEqual(calls.at(-1)?.at, 19 * MINUTE);
      }),
    ),
  );

  it.effect(
    "reads the setting on each due attempt, including disabling and re-enabling during retry",
    () =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture({ failures: 1 });
          yield* Ref.set(f.enabled, false);
          yield* TestClock.adjust(11 * MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
          yield* Ref.set(f.enabled, true);
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
          yield* Ref.set(f.enabled, false);
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
          yield* Ref.set(f.enabled, true);
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual((yield* Queue.take(f.results)).status, "used");
          assert.strictEqual((yield* Ref.get(f.calls)).length, 2);
        }),
      ),
  );

  it.effect("reschedules a changed credit and cancels a removed or switched account", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* TestClock.adjust(5 * MINUTE);
        yield* f.update([provider(30 * MINUTE, "codex", "replacement")]);
        yield* TestClock.adjust(10 * MINUTE);
        assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
        yield* TestClock.adjust(5 * MINUTE);
        assert.strictEqual((yield* Queue.take(f.results)).creditId, "replacement");
        yield* f.update([provider(40 * MINUTE, "codex", "removed")]);
        yield* TestClock.adjust(MINUTE);
        yield* f.update([]);
        yield* TestClock.adjust(20 * MINUTE);
        assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
      }),
    ),
  );

  it.effect("does not redeem credits first discovered inside the stop window", () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture({ providers: [provider(MINUTE - 1)] });
        yield* TestClock.adjust(5 * MINUTE);
        assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
      }),
    ),
  );
});

it.effect(
  "carries results in usage snapshots across refreshes without leaking them to another account",
  () =>
    Effect.gen(function* () {
      const first = provider(20 * MINUTE);
      const snapshots = yield* Ref.make<readonly ServerProvider[]>([first]);
      const changes = yield* PubSub.unbounded<readonly ServerProvider[]>();
      const subscription = yield* PubSub.subscribe(changes);
      const publisher = yield* makeResetCreditExpiryResults(snapshots, changes);
      const result: ResetCreditAutoUseResult = {
        creditId: "credit-a",
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(20 * MINUTE)),
        attemptedAt: DateTime.formatIso(DateTime.makeUnsafe(10 * MINUTE)),
        status: "used",
      };
      yield* publisher.publish(first.instanceId, resetCreditAccountKey(first), result);
      assert.deepStrictEqual(
        (yield* PubSub.take(subscription))[0]?.usageLimits?.resetCreditAutoUse,
        result,
      );
      assert.deepStrictEqual(publisher.decorate(first).usageLimits?.resetCreditAutoUse, result);
      const other = { ...first, auth: { ...first.auth, email: "other@example.com" } };
      assert.isUndefined(publisher.decorate(other).usageLimits?.resetCreditAutoUse);
      yield* Ref.set(snapshots, [other]);
      yield* publisher.publish(first.instanceId, resetCreditAccountKey(first), result);
      assert.isUndefined((yield* Ref.get(snapshots))[0]?.usageLimits?.resetCreditAutoUse);
    }).pipe(Effect.scoped),
);

it.effect(
  "auto-uses a hub account through the existing source service, pinning source, account and credit",
  () =>
    test(
      Effect.gen(function* () {
        const value = provider(20 * MINUTE);
        const sourceId = UsageLimitSourceId.make("hub");
        const f = yield* fixture({
          providers: [],
          sources: [
            {
              id: sourceId,
              kind: "cliproxy",
              label: "Hub",
              checkedAt: value.checkedAt,
              accounts: [
                {
                  id: "hub-account",
                  driver: value.driver,
                  email: value.auth.email,
                  usageLimits: value.usageLimits!,
                },
              ],
            },
          ],
        });
        yield* TestClock.adjust(10 * MINUTE);
        assert.strictEqual((yield* Queue.take(f.results)).status, "used");
        assert.deepStrictEqual(yield* Ref.get(f.sourceInputs), [
          { sourceId, accountId: "hub-account", creditId: "credit-a" },
        ]);
      }),
    ),
);

it.effect("does not retry a permanent no-credit outcome", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture({ outcome: "noCredit" });
      yield* TestClock.adjust(10 * MINUTE);
      assert.strictEqual((yield* Queue.take(f.results)).status, "failed");
      yield* TestClock.adjust(10 * MINUTE);
      assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
    }),
  ),
);

it.effect("publishes hub results in the existing source snapshot and retains them on refresh", () =>
  Effect.gen(function* () {
    const value = provider(20 * MINUTE);
    const sourceId = UsageLimitSourceId.make("hub");
    const source: UsageLimitSourceSnapshot = {
      id: sourceId,
      kind: "cliproxy",
      label: "Hub",
      checkedAt: value.checkedAt,
      accounts: [
        { id: "a", driver: value.driver, email: value.auth.email, usageLimits: value.usageLimits! },
      ],
    };
    const snapshots = yield* Ref.make<readonly UsageLimitSourceSnapshot[]>([source]);
    const changes = yield* PubSub.unbounded<readonly UsageLimitSourceSnapshot[]>();
    const subscription = yield* PubSub.subscribe(changes);
    const publisher = yield* makeSourceResetCreditExpiryResults(snapshots, changes);
    const result: ResetCreditAutoUseResult = {
      creditId: "credit-a",
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(20 * MINUTE)),
      attemptedAt: DateTime.formatIso(DateTime.makeUnsafe(10 * MINUTE)),
      status: "failed",
    };
    yield* publisher.publish(
      sourceId,
      "a",
      resetCreditSourceAccountKey(sourceId, source.accounts[0]!),
      result,
    );
    assert.deepStrictEqual(
      (yield* PubSub.take(subscription))[0]?.accounts[0]?.usageLimits.resetCreditAutoUse,
      result,
    );
    assert.deepStrictEqual(
      publisher.decorate(source).accounts[0]?.usageLimits.resetCreditAutoUse,
      result,
    );
    assert.isUndefined(
      publisher.decorate({
        ...source,
        accounts: [{ ...source.accounts[0]!, email: "other@example.com" }],
      }).accounts[0]?.usageLimits.resetCreditAutoUse,
    );
  }).pipe(Effect.scoped),
);

it.effect("waits again after a backwards wall-clock correction", () =>
  test(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      let drift = 0;
      const corrected = {
        ...clock,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() - drift,
        currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() - drift),
      };
      const f = yield* fixture().pipe(Effect.provideService(Clock.Clock, corrected));
      yield* TestClock.adjust(5 * MINUTE);
      drift = 5 * MINUTE;
      yield* TestClock.adjust(5 * MINUTE);
      assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
      yield* TestClock.adjust(5 * MINUTE);
      assert.strictEqual((yield* Queue.take(f.results)).status, "used");
      assert.strictEqual((yield* Ref.get(f.calls))[0]?.at, 10 * MINUTE);
    }),
  ),
);

it.effect.each(
  (["opt-out", "cutoff", "backwards clock"] as const).flatMap((reason) =>
    [false, true].map((hub) => ({ reason, hub })),
  ),
)(
  "rechecks $reason after queued redemption acquires the account lock (hub: $hub)",
  ({ reason, hub }) =>
    test(
      Effect.gen(function* () {
        const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const gate = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const holder = yield* coordinator
          .redeem("shared-account", () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);
              return "nothingToReset" as const;
            }),
          )
          .pipe(Effect.orDie, Effect.forkChild);
        yield* Deferred.await(entered);
        const clock = yield* Clock.Clock;
        let drift = 0;
        const value = provider(10 * MINUTE);
        const f = yield* fixture(
          hub
            ? {
                providers: [],
                sources: [
                  {
                    id: UsageLimitSourceId.make("hub"),
                    kind: "cliproxy",
                    label: "Hub",
                    checkedAt: value.checkedAt,
                    accounts: [
                      {
                        id: "a",
                        driver: value.driver,
                        email: value.auth.email,
                        usageLimits: value.usageLimits!,
                      },
                    ],
                  },
                ],
              }
            : { providers: [value] },
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() - drift,
            currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() - drift),
          }),
        );
        yield* Deferred.await(f.queued);
        if (reason === "opt-out") yield* Ref.set(f.enabled, false);
        else if (reason === "cutoff") yield* TestClock.adjust(9 * MINUTE + 1);
        else drift = MINUTE;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(holder);
        yield* Deferred.await(f.completed);
        assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
      }),
    ),
);

it.effect("permits redemption at the exact one-minute boundary", () =>
  test(
    Effect.gen(function* () {
      const f = yield* fixture({ providers: [provider(MINUTE)] });
      yield* TestClock.adjust(0);
      assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
      assert.strictEqual((yield* Queue.take(f.results)).status, "used");
    }),
  ),
);
