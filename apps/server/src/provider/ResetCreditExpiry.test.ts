import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceError,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ResetCreditExpiry from "./ResetCreditExpiry.ts";

const expiry = DateTime.formatIso(DateTime.makeUnsafe(11 * 60_000));
const hub = (id: string, email = "user@example.test"): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make(id),
  kind: "cliproxy",
  label: id,
  endpoint: `https://${id}.test`,
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
  accounts: [
    {
      id: "account.json",
      driver: ProviderDriverKind.make("codex"),
      email,
      workspaceId: "workspace",
      usageLimits: {
        windows: [],
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
        resetCredits: { availableCount: 1, nextCreditId: "grant", nextExpiresAt: expiry },
      },
    },
  ],
});

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

const start = (
  sources: UsageLimitSources.UsageLimitSources["Service"],
  localReport?: ServerProvider,
) =>
  ResetCreditExpiry.start.pipe(
    Effect.provide([
      Layer.succeed(UsageLimitSources.UsageLimitSources, sources),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        streamChanges: Stream.empty,
        getProviders: Effect.succeed(localReport ? [localReport] : []),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.succeed(
          localReport
            ? [
                {
                  enabled: true,
                  instanceId: localReport.instanceId,
                  consumeResetCredit: () => Effect.die("The hub owns this credit"),
                } as ProviderInstance,
              ]
            : [],
        ),
        streamChanges: Stream.empty,
      }),
      Settings.layerTest({ autoUseExpiringResetCredits: true }),
    ]),
  );

it.effect("serializes duplicate accounts and paces retries after unconfirmed redemption", () =>
  Effect.gen(function* () {
    const polls = yield* Queue.unbounded<readonly UsageLimitSourceSnapshot[]>();
    const calls = yield* Queue.unbounded<UsageLimitSourceId>();
    const refreshed = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    const attempts = yield* Ref.make(0);
    const first = hub("first");
    const second = hub("second");
    const snapshots = yield* Ref.make<readonly UsageLimitSourceSnapshot[]>([first, second]);
    const account = first.accounts[0]!;
    yield* start(
      {
        current: Ref.get(snapshots),
        streamChanges: Stream.fromQueue(polls),
        refresh: Effect.gen(function* () {
          if ((yield* Ref.get(attempts)) === 3) yield* Ref.set(snapshots, []);
          yield* Queue.offer(refreshed, undefined);
        }),
        consumeResetCredit: ({ sourceId }, automatic) =>
          Effect.gen(function* () {
            expect(yield* automatic!.canRedeem).toBe(true);
            yield* Queue.offer(calls, sourceId);
            const number = yield* Ref.updateAndGet(attempts, (count) => count + 1);
            if (number === 1) {
              yield* Deferred.await(release);
              return yield* new UsageLimitSourceError({ detail: "Unconfirmed" });
            }
            return { outcome: "reset" } as const;
          }),
      },
      decodeProvider({
        instanceId: ProviderInstanceId.make("local"),
        driver: account.driver,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        models: [],
        auth: { status: "authenticated", email: account.email, workspaceId: account.workspaceId },
        checkedAt: account.usageLimits.checkedAt,
        usageLimits: account.usageLimits,
      }),
    );

    yield* TestClock.adjust("59 seconds");
    expect(yield* Ref.get(attempts)).toBe(0);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(calls)).toBe(first.id);
    yield* Queue.offer(polls, [first, second]);
    yield* TestClock.adjust("30 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);

    yield* Deferred.succeed(release, undefined);
    yield* Queue.take(refreshed);
    yield* TestClock.adjust("59 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(calls)).toBe(first.id);
    yield* Queue.take(refreshed);
    yield* TestClock.adjust("1 minute");
    expect(yield* Queue.take(calls)).toBe(first.id);
    yield* Queue.take(refreshed);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Ref.get(attempts)).toBe(3);
  }),
);

it.effect("allows the same grant ID on two distinct accounts", () =>
  Effect.gen(function* () {
    const one = hub("first");
    const two = hub("second", "other@example.test");
    const calls = yield* Queue.unbounded<UsageLimitSourceId>();
    yield* start({
      current: Effect.succeed([one, two]),
      streamChanges: Stream.empty,
      refresh: Effect.void,
      consumeResetCredit: ({ sourceId }, automatic) =>
        Effect.gen(function* () {
          expect(yield* automatic!.canRedeem).toBe(true);
          yield* Queue.offer(calls, sourceId);
          return { outcome: "reset" } as const;
        }),
    });
    yield* TestClock.adjust("1 minute");
    expect(new Set([yield* Queue.take(calls), yield* Queue.take(calls)])).toEqual(
      new Set([one.id, two.id]),
    );
  }),
);

it.effect("refreshes an unreadable credit list without spending until the same grant returns", () =>
  Effect.gen(function* () {
    const source = hub("hub");
    const unreadable = {
      ...source,
      accounts: source.accounts.map(({ usageLimits, ...account }) => ({
        ...account,
        usageLimits: { ...usageLimits, resetCredits: undefined },
      })),
    };
    const current = yield* Ref.make<readonly UsageLimitSourceSnapshot[]>([source]);
    const calls = yield* Ref.make<string[]>([]);
    const refreshes = yield* Ref.make(0);
    yield* start({
      current: Ref.get(current),
      streamChanges: Stream.empty,
      refresh: Effect.gen(function* () {
        const reads = yield* Ref.updateAndGet(refreshes, (count) => count + 1);
        yield* Ref.set(current, reads < 3 ? [unreadable] : reads === 3 ? [source] : []);
      }),
      consumeResetCredit: ({ creditId }, automatic) =>
        Effect.gen(function* () {
          expect(yield* automatic!.canRedeem).toBe(true);
          const seen = yield* Ref.updateAndGet(calls, (credits) => [...credits, creditId]);
          if (seen.length === 1) return yield* new UsageLimitSourceError({ detail: "Unconfirmed" });
          return { outcome: "reset" } as const;
        }),
    });
    yield* TestClock.adjust("2 minutes");
    expect(yield* Ref.get(refreshes)).toBe(2);
    expect(yield* Ref.get(calls)).toEqual(["grant"]);
    yield* TestClock.adjust("1 minute");
    expect(yield* Ref.get(refreshes)).toBe(3);
    expect(yield* Ref.get(calls)).toEqual(["grant"]);
    yield* TestClock.adjust("1 minute");
    expect(yield* Ref.get(calls)).toEqual(["grant", "grant"]);
  }),
);

it.effect.each([0, 1])(
  "checks the one-minute cutoff after preparation with a %s ms offset",
  (offset) =>
    Effect.gen(function* () {
      const source = hub("hub");
      const preparing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const allowed = yield* Deferred.make<boolean>();
      yield* start({
        current: Effect.succeed([source]),
        streamChanges: Stream.empty,
        refresh: Effect.void,
        consumeResetCredit: (_input, automatic) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(preparing, undefined);
            yield* Deferred.await(release);
            yield* Deferred.succeed(allowed, yield* automatic!.canRedeem);
            return { outcome: "nothingToReset" } as const;
          }),
      });
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(preparing);
      yield* TestClock.adjust(9 * 60_000 + offset);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Deferred.await(allowed)).toBe(offset === 0);
    }),
);

it.effect("rejects a grant whose owning source changes during preparation", () =>
  Effect.gen(function* () {
    const first = hub("first");
    const second = hub("second");
    const snapshots = yield* Ref.make<readonly UsageLimitSourceSnapshot[]>([first, second]);
    const preparing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const refreshed = yield* Deferred.make<void>();
    const canSpend = yield* Ref.make<boolean[]>([]);
    yield* start({
      current: Ref.get(snapshots),
      streamChanges: Stream.empty,
      refresh: Deferred.succeed(refreshed, undefined).pipe(Effect.asVoid),
      consumeResetCredit: (_input, automatic) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(preparing, undefined);
          yield* Deferred.await(release);
          const allowed = yield* automatic!.canRedeem;
          yield* Ref.update(canSpend, (seen) => [...seen, allowed]);
          return { outcome: "nothingToReset" } as const;
        }),
    });
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(preparing);
    yield* Ref.set(snapshots, [second]);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(refreshed);
    yield* TestClock.adjust("2 minutes");
    expect(yield* Ref.get(canSpend)).toEqual([false]);
  }),
);
