import { ProviderInstanceRegistryMutator } from "./ProviderInstanceRegistryMutator.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerConfig from "../config.ts";
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
import { claudeResetCreditsToContract } from "./claudeResetCredits.ts";
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
        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
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
    readonly removeAfterRefreshes?: number;
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
  const sourceSnapshots = yield* Ref.make(input.sources ?? []);
  const refreshes = yield* Ref.make(0);
  const refresh = Effect.gen(function* () {
    const count = yield* Ref.updateAndGet(refreshes, (n) => n + 1);
    const callsSoFar = yield* Ref.get(calls);
    const remove =
      input.removeAfterRefreshes !== undefined
        ? count >= input.removeAfterRefreshes
        : (input.outcome ?? "reset") === "reset" && callsSoFar.length > (input.failures ?? 0);
    if (remove) {
      yield* Ref.update(snapshots, (values) =>
        values.map((value) => ({
          ...value,
          usageLimits: { ...value.usageLimits!, resetCredits: { availableCount: 0 } },
        })),
      );
      yield* Ref.update(sourceSnapshots, (values) =>
        values.map((source) => ({
          ...source,
          accounts: source.accounts.map((account) => ({
            ...account,
            usageLimits: { ...account.usageLimits, resetCredits: { availableCount: 0 } },
          })),
        })),
      );
    }
    yield* PubSub.publish(updates, yield* Ref.get(snapshots));
  });
  const sourceInputs = yield* Ref.make<readonly UsageLimitSourceConsumeResetCreditInput[]>([]);
  const deps = Layer.mergeAll(
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Ref.get(sourceSnapshots),
      streamChanges: Stream.fromEffect(Ref.get(sourceSnapshots)),
      refresh,
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
      refreshInstance: () => refresh.pipe(Effect.andThen(Ref.get(snapshots))),
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
  return { calls, results, enabled, update, sourceInputs, queued, completed, refreshes };
});

const test = (
  program: Effect.Effect<
    void,
    never,
    import("effect/Scope").Scope | ResetCreditCoordinator.ResetCreditCoordinator
  >,
) => program.pipe(Effect.scoped, Effect.provide(ResetCreditCoordinator.layerTest));

describe("banked reset auto-use", () => {
  it.effect.each([false, true])(
    "schedules the selected Claude grant at its own expiry minus ten minutes (hub: %s)",
    (hub) =>
      test(
        Effect.gen(function* () {
          const selectedExpiry = 24 * 60 * MINUTE;
          const value = provider(selectedExpiry, "claude", "later");
          const credits = claudeResetCreditsToContract(
            {
              eligible: true,
              next_grant_id: "later",
              grants: [
                {
                  id: "earlier",
                  resets_left: 1,
                  usable_now: true,
                  ends_at: DateTime.formatIso(DateTime.makeUnsafe(20 * MINUTE)),
                },
                {
                  id: "later",
                  resets_left: 1,
                  usable_now: true,
                  ends_at: DateTime.formatIso(DateTime.makeUnsafe(selectedExpiry)),
                },
              ],
            },
            0,
          )!;
          const claude = {
            ...value,
            driver: ProviderDriverKind.make("claudeAgent"),
            usageLimits: { ...value.usageLimits!, resetCredits: credits },
          };
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
                        { id: "a", driver: claude.driver, usageLimits: claude.usageLimits },
                      ],
                    },
                  ],
                }
              : { providers: [claude] },
          );
          yield* TestClock.adjust(10 * MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
          yield* TestClock.adjust(selectedExpiry - 20 * MINUTE - 1);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
          yield* TestClock.adjust(1);
          const result = yield* Queue.take(f.results);
          assert.strictEqual(result.status, "used");
          assert.strictEqual(result.expiresAt, credits.nextExpiresAt);
          const calls = yield* Ref.get(f.calls);
          assert.strictEqual(calls.length, 1);
          assert.strictEqual(calls[0]?.creditId, "later");
          assert.strictEqual(calls[0]?.at, selectedExpiry - 10 * MINUTE);
        }),
      ),
  );

  it.effect.each([false, true])(
    "does not schedule an ID without its selected expiry (hub: %s)",
    (hub) =>
      test(
        Effect.gen(function* () {
          const value = provider(20 * MINUTE);
          const { nextExpiresAt: _expiry, ...credits } = value.usageLimits!.resetCredits!;
          const limits = { ...value.usageLimits!, resetCredits: credits };
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
                      accounts: [{ id: "a", driver: value.driver, usageLimits: limits }],
                    },
                  ],
                }
              : { providers: [{ ...value, usageLimits: limits }] },
          );
          yield* TestClock.adjust(20 * MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 0);
        }),
      ),
  );

  it.effect.each(
    (["reset", "alreadyRedeemed", "noCredit", "nothingToReset", "error"] as const).flatMap(
      (outcome) => [false, true].map((hub) => ({ outcome, hub })),
    ),
  )(
    "refreshes and retries a listed credit after $outcome, reporting used only when it disappears (hub: $hub)",
    ({ outcome, hub }) =>
      test(
        Effect.gen(function* () {
          const f = yield* fixture({
            ...(outcome === "error" ? { failures: 10 } : { outcome }),
            removeAfterRefreshes: 2,
            providers: [provider(20 * MINUTE), provider(20 * MINUTE, "second")],
            ...(hub
              ? {
                  providers: [],
                  sources: [
                    {
                      id: UsageLimitSourceId.make("hub"),
                      kind: "cliproxy" as const,
                      label: "Hub",
                      checkedAt: provider(20 * MINUTE).checkedAt,
                      accounts: [
                        {
                          id: "a",
                          driver: ProviderDriverKind.make("codex"),
                          usageLimits: provider(20 * MINUTE).usageLimits!,
                        },
                      ],
                    },
                  ],
                }
              : {}),
          });
          yield* TestClock.adjust(10 * MINUTE);
          assert.strictEqual(yield* Ref.get(f.refreshes), 1);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 1);
          assert.strictEqual(yield* Queue.size(f.results), 0);
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual(yield* Ref.get(f.refreshes), 2);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 2);
          assert.strictEqual((yield* Queue.take(f.results)).status, "used");
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual((yield* Ref.get(f.calls)).length, 2);
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
        yield* TestClock.adjust(19 * MINUTE);
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

it.effect(
  "retries no-credit while the snapshot lists the credit and reports failure at cutoff",
  () =>
    test(
      Effect.gen(function* () {
        const f = yield* fixture({ outcome: "noCredit" });
        yield* TestClock.adjust(10 * MINUTE);
        assert.strictEqual(yield* Queue.size(f.results), 0);
        yield* TestClock.adjust(10 * MINUTE);
        assert.strictEqual((yield* Queue.take(f.results)).status, "failed");
        assert.strictEqual((yield* Ref.get(f.calls)).length, 10);
        assert.strictEqual(yield* Ref.get(f.refreshes), 10);
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

it.effect("paces failed refreshes when the registry retains a stale selected credit", () =>
  Effect.gen(function* () {
    const initial = provider(20 * MINUTE);
    const live = yield* Ref.make(initial);
    const streamGate = yield* Deferred.make<void>();
    const refreshGate = yield* Deferred.make<void>();
    const refreshTimes: number[] = [];
    const refreshed = yield* Queue.unbounded<void>();
    const ready = yield* Deferred.make<void>();
    let consumes = 0;
    const instance: ProviderInstance = {
      instanceId: initial.instanceId,
      driverKind: initial.driver,
      enabled: true,
      displayName: undefined,
      continuationIdentity: { driverKind: initial.driver, continuationKey: initial.instanceId },
      snapshot: {
        getSnapshot: Ref.get(live),
        resolveMaintenance: () => Effect.die("Maintenance must not run during credit auto-use"),
        applyUsageLimits: () => Effect.void,
        // Hold subscription delivery so the real registry must recover its cached snapshot.
        streamChanges: Stream.fromEffect(
          Deferred.await(streamGate).pipe(Effect.andThen(Ref.get(live))),
        ),
        refresh: Effect.gen(function* () {
          refreshTimes.push(yield* Clock.currentTimeMillis);
          yield* Queue.offer(refreshed, undefined);
          // Bound the broken immediate loop so its assertion can fail without hanging.
          if (refreshTimes.length === 3) yield* Deferred.await(refreshGate);
          return yield* Effect.die("refresh failed before producing a snapshot");
        }),
      },
      consumeResetCredit: (_expected, guard) =>
        Effect.gen(function* () {
          if (guard && !(yield* guard)) return "nothingToReset" as const;
          consumes++;
          yield* Ref.set(live, provider(30 * MINUTE, "codex", "credit-b"));
          return "reset" as const;
        }),
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const changes = yield* PubSub.unbounded<void>();
    const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      getInstance: () => Effect.succeed(instance),
      subscribeChanges: PubSub.subscribe(changes),
    });
    const registry = yield* ProviderRegistry.ProviderRegistry.pipe(
      Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(instances))),
    );
    const deps = Layer.mergeAll(
      instances,
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        ...registry,
        subscribeChanges: registry.subscribeChanges.pipe(
          Effect.map((stream) => stream.pipe(Stream.tap(() => Deferred.succeed(ready, undefined)))),
        ),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([]),
        streamChanges: Stream.make([]),
      }),
      Settings.layerTest({ autoUseExpiringResetCredits: true }),
    );
    const scheduler = yield* ResetCreditExpiry.ResetCreditExpiry.pipe(
      Effect.provide(ResetCreditExpiry.layer.pipe(Layer.provide(deps))),
    );
    yield* scheduler.start;
    yield* Deferred.await(ready);
    yield* TestClock.adjust(10 * MINUTE);
    yield* Queue.take(refreshed);
    yield* TestClock.adjust(0);
    assert.deepStrictEqual([...refreshTimes], [10 * MINUTE]);
    yield* TestClock.adjust(MINUTE - 1);
    assert.deepStrictEqual([...refreshTimes], [10 * MINUTE]);
    yield* TestClock.adjust(1);
    assert.deepStrictEqual([...refreshTimes], [10 * MINUTE, 11 * MINUTE]);
    assert.strictEqual(consumes, 1);
    assert.strictEqual(
      (yield* registry.getProviders)[0]?.usageLimits?.resetCredits?.nextCreditId,
      "credit-a",
    );
    assert.strictEqual((yield* Ref.get(live)).usageLimits?.resetCredits?.nextCreditId, "credit-b");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-credit-pacing-" }),
        ModelManifest.layerTest,
        Layer.mock(ProviderInstanceRegistryMutator)({ reloadSecrets: () => Effect.void }),
        ProviderLatestVersions.layer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  ),
);
