import type {
  ProviderConsumeResetCreditOutcome,
  ResetCreditAutoUseResult,
  ServerProvider,
  UsageLimitSourceError,
  UsageLimitSourceSnapshot,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { ProviderDriverError } from "./Errors.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as Settings from "../serverSettings.ts";
import {
  resetCreditAccountKey,
  resetCreditSourceAccountKey,
  resetCreditAutoUseStatus,
} from "./ResetCreditExpiryResults.ts";

const MINUTE = 60_000;
interface ExpiringCredit {
  readonly accountKey: string;
  readonly owner: string;
  readonly creditId: string;
  readonly expiresAt: string;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<unknown>;
  readonly usage: Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly redeem: (
    canRedeem: Effect.Effect<boolean>,
  ) => Effect.Effect<
    ProviderConsumeResetCreditOutcome | "stale",
    ProviderDriverError | UsageLimitSourceError
  >;
  readonly publish: (result: ResetCreditAutoUseResult) => Effect.Effect<void>;
}
const creditSignature = (parts: readonly string[]) => parts.map(encodeURIComponent).join(":");

export class ResetCreditExpiry extends Context.Service<
  ResetCreditExpiry,
  { readonly start: Effect.Effect<void, never, Scope.Scope> }
>()("t3/provider/ResetCreditExpiry") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const settings = yield* Settings.ServerSettingsService;
  const jobs = new Map<
    string,
    {
      readonly signature: string;
      readonly fiber: Fiber.Fiber<void>;
      readonly redemption: { active: boolean };
    }
  >();

  const providerCredits = (providers: readonly ServerProvider[]): ExpiringCredit[] =>
    providers.flatMap((provider) => {
      const credits = provider.usageLimits?.resetCredits;
      const expiresAt = credits?.nextExpiresAt;
      if (
        !provider.enabled ||
        provider.auth.status === "unauthenticated" ||
        !credits?.availableCount ||
        !credits.nextCreditId ||
        !expiresAt
      )
        return [];
      const creditId = credits.nextCreditId;
      const accountKey = resetCreditAccountKey(provider);
      const isCurrent = Effect.gen(function* () {
        const instance = yield* instances.getInstance(provider.instanceId);
        if (!instance?.enabled || !instance.consumeResetCredit) return false;
        const current = yield* instance.snapshot.getSnapshot;
        return (
          resetCreditAccountKey(current) === accountKey &&
          current.usageLimits?.resetCredits?.nextCreditId === creditId &&
          current.usageLimits.resetCredits.nextExpiresAt === expiresAt
        );
      });
      return [
        {
          accountKey,
          owner: provider.instanceId,
          creditId,
          expiresAt,
          isCurrent,
          refresh: registry.refreshInstance(provider.instanceId),
          usage: registry.getProviders.pipe(
            Effect.map(
              (values) =>
                values.find(
                  (value) =>
                    value.instanceId === provider.instanceId &&
                    resetCreditAccountKey(value) === accountKey,
                )?.usageLimits,
            ),
          ),
          redeem: Effect.fn("ResetCreditExpiry.redeemProvider")(function* (
            canRedeem: Effect.Effect<boolean>,
          ) {
            const instance = yield* instances.getInstance(provider.instanceId);
            if (!instance?.enabled || !instance.consumeResetCredit) return "stale" as const;
            if (!(yield* isCurrent)) return "stale" as const;
            return yield* instance.consumeResetCredit({ creditId }, canRedeem);
          }),
          publish: (result: ResetCreditAutoUseResult) =>
            registry.publishResetCreditAutoUse(provider.instanceId, accountKey, result),
        },
      ];
    });
  const sourceCredits = (snapshots: readonly UsageLimitSourceSnapshot[]): ExpiringCredit[] =>
    snapshots.flatMap((source) =>
      source.accounts.flatMap((account) => {
        const credits = account.usageLimits.resetCredits;
        const expiresAt = credits?.nextExpiresAt;
        if (!credits?.availableCount || !credits.nextCreditId || !expiresAt) return [];
        const creditId = credits.nextCreditId;
        const accountKey = resetCreditSourceAccountKey(source.id, account);
        const isCurrent = Effect.gen(function* () {
          const current = (yield* sources.current)
            .find((value) => value.id === source.id)
            ?.accounts.find((value) => value.id === account.id);
          return (
            current !== undefined &&
            resetCreditSourceAccountKey(source.id, current) === accountKey &&
            current.usageLimits.resetCredits?.nextCreditId === creditId &&
            current.usageLimits.resetCredits.nextExpiresAt === expiresAt
          );
        });
        return [
          {
            accountKey,
            owner: `${source.id}/${account.id}`,
            creditId,
            expiresAt,
            isCurrent,
            refresh: sources.refresh,
            usage: sources.current.pipe(
              Effect.map(
                (values) =>
                  values
                    .find((value) => value.id === source.id)
                    ?.accounts.find(
                      (value) =>
                        value.id === account.id &&
                        resetCreditSourceAccountKey(source.id, value) === accountKey,
                    )?.usageLimits,
              ),
            ),
            redeem: Effect.fn("ResetCreditExpiry.redeemSource")(function* (
              canRedeem: Effect.Effect<boolean>,
            ) {
              if (!(yield* isCurrent)) return "stale" as const;
              const result = yield* sources.consumeResetCredit(
                {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId,
                },
                canRedeem,
              );
              return result.outcome;
            }),
            publish: (result: ResetCreditAutoUseResult) =>
              sources.publishResetCreditAutoUse(source.id, account.id, accountKey, result),
          },
        ];
      }),
    );

  const start = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const reschedule = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
    const reconcile = Effect.fn("ResetCreditExpiry.reconcile")(function* () {
      const providers = providerCredits(yield* registry.getProviders);
      const hubAccounts = sourceCredits(yield* sources.current);
      const candidates = new Map<string, ExpiringCredit>();
      for (const credit of [...providers, ...hubAccounts]) {
        if (!candidates.has(credit.accountKey)) candidates.set(credit.accountKey, credit);
      }
      for (const [accountKey, job] of jobs) {
        const credit = candidates.get(accountKey);
        const signature = credit
          ? creditSignature([credit.owner, credit.creditId, credit.expiresAt])
          : null;
        // A driver's refresh publishes while redemption is still returning its result.
        if (signature !== job.signature && !job.redemption.active) {
          yield* Fiber.interrupt(job.fiber);
          jobs.delete(accountKey);
        }
      }
      for (const [accountKey, credit] of candidates) {
        if (jobs.has(accountKey)) continue;
        const { creditId, expiresAt } = credit;
        const expiry = Date.parse(expiresAt);
        if (!Number.isFinite(expiry) || expiry - (yield* Clock.currentTimeMillis) < MINUTE)
          continue;
        const signature = creditSignature([credit.owner, creditId, expiresAt]);
        const redemption = { active: false };
        const run = Effect.gen(function* () {
          let attempted = false;
          const report = Effect.fn("ResetCreditExpiry.report")(function* () {
            const now = yield* Clock.currentTimeMillis;
            const status = resetCreditAutoUseStatus(yield* credit.usage, creditId, expiresAt, now);
            if (status)
              yield* credit.publish({
                creditId,
                expiresAt,
                attemptedAt: DateTime.formatIso(yield* DateTime.now),
                status,
              });
          });
          const attempt = Effect.gen(function* () {
            const wait = expiry - 10 * MINUTE - (yield* Clock.currentTimeMillis);
            if (wait > 0) yield* Effect.sleep(wait);
            const now = yield* Clock.currentTimeMillis;
            // Wall time can move backwards independently of the timer. Retry without spending.
            if (now < expiry - 10 * MINUTE) return false;
            if (now > expiry - MINUTE) {
              if (attempted) yield* report();
              return true;
            }
            const enabled = yield* settings.getSettings.pipe(
              Effect.map((value) => value.autoUseExpiringResetCredits),
              Effect.orElseSucceed(() => false),
            );
            if (!enabled) return false;
            redemption.active = true;
            attempted = true;
            yield* credit
              .redeem(
                Effect.gen(function* () {
                  // This runs inside the redemption lock, after provider setup, at the spend boundary.
                  const currentSettings = yield* settings.getSettings.pipe(
                    Effect.orElseSucceed(() => null),
                  );
                  // The hub reads under its refresh lock; direct drivers read after provider setup.
                  const current = yield* credit.isCurrent;
                  const currentTime = yield* Clock.currentTimeMillis;
                  const permitted =
                    current &&
                    currentSettings?.autoUseExpiringResetCredits === true &&
                    currentTime >= expiry - 10 * MINUTE &&
                    currentTime <= expiry - MINUTE;
                  return permitted;
                }),
              )
              .pipe(Effect.ignoreCause({ log: true }));
            // Every outcome, including a skipped spend or an error, must re-read provider truth.
            yield* credit.refresh;
            yield* report();
            redemption.active = false;
            if (!(yield* credit.isCurrent)) {
              jobs.delete(accountKey);
              // Reconcile on the subscription fiber so concurrent jobs cannot race scheduling.
              yield* Queue.offer(reschedule, undefined);
              return true;
            }
            return (yield* Clock.currentTimeMillis) >= expiry - MINUTE;
          });
          yield* attempt.pipe(
            Effect.repeat({ schedule: Schedule.spaced("1 minute"), until: (done) => done }),
          );
        }).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));
        const fiber = yield* run.pipe(Effect.forkIn(scope));
        jobs.set(accountKey, { signature, fiber, redemption });
      }
    });
    const changes = yield* registry.subscribeChanges;
    yield* Stream.merge(changes, sources.streamChanges).pipe(
      Stream.merge(Stream.fromQueue(reschedule)),
      Stream.runForEach(reconcile),
      Effect.forkScoped,
    );
  });
  return { start };
});

export const layer = Layer.effect(ResetCreditExpiry, make);
