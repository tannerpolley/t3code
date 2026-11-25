import type { ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import type { AutomaticResetCredit } from "@t3tools/provider-core/server/driver";
import { accountKeyResolver } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const MINUTE = 60_000;

type Owner =
  | { readonly instanceId: ProviderInstanceId }
  | {
      readonly sourceId: UsageLimitSourceId;
      readonly endpoint: string | undefined;
      readonly accountId: string;
    };

interface Candidate extends Omit<AutomaticResetCredit, "canRedeem"> {
  readonly key: string;
  readonly ownerKey: string;
  readonly signature: string;
  readonly owner: Owner;
  readonly opens: number;
  readonly closes: number;
}

export const start = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const settings = yield* Settings.ServerSettingsService;
  const changes = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  const attempts = new Map<string, { credit: Candidate; retryAt: number }>();

  const selections = Effect.gen(function* () {
    const hubs = yield* sources.current;
    const providers = yield* registry.getProviders;
    const redeemable = new Set(
      (yield* instances.listInstances)
        .filter((instance) => instance.enabled && instance.consumeResetCredit)
        .map((instance) => instance.instanceId),
    );
    const reports = [
      ...hubs.flatMap((source) =>
        source.accounts
          .filter((account) => account.driver === "codex")
          .map((account) => ({
            ...account,
            owner: { sourceId: source.id, endpoint: source.endpoint, accountId: account.id },
          })),
      ),
      ...providers
        .filter(
          (provider) =>
            provider.enabled &&
            provider.auth.status === "authenticated" &&
            redeemable.has(provider.instanceId),
        )
        .map((provider) => ({
          driver: provider.driver,
          email: provider.auth.email,
          workspaceId: provider.auth.workspaceId,
          usageLimits: provider.usageLimits,
          owner: { instanceId: provider.instanceId },
        })),
    ];
    const accountKey = accountKeyResolver(reports);
    const owners = new Set<string>();
    const selected: Candidate[] = [];
    const unknown = new Set<string>();
    for (const report of reports) {
      const account = accountKey(report);
      const email = report.email?.trim().toLowerCase();
      if (!account || !email || owners.has(account)) continue;
      // Use the hub when it holds the same account, even when its credit list is unreadable.
      owners.add(account);
      const credits = report.usageLimits?.resetCredits;
      const ownerKey = JSON.stringify([account, report.owner, email, report.workspaceId]);
      if (report.usageLimits?.unavailable || !credits) {
        unknown.add(ownerKey);
        continue;
      }
      const creditId = credits.nextCreditId;
      const expiresAt = credits.nextExpiresAt;
      if (!credits.availableCount || !creditId || !expiresAt) {
        continue;
      }
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) continue;
      selected.push({
        key: JSON.stringify([account, creditId]),
        ownerKey,
        signature: JSON.stringify([ownerKey, expiresAt]),
        owner: report.owner,
        creditId,
        expiresAt,
        email,
        workspaceId: report.workspaceId,
        opens: expiry - 10 * MINUTE,
        closes: expiry - MINUTE,
      });
    }
    return { selected, unknown };
  });

  const refreshOwner = Effect.fn("ResetCreditExpiry.refreshOwner")(
    function* (owner: Owner) {
      if ("sourceId" in owner) return yield* sources.refresh;
      const instance = yield* instances.getInstance(owner.instanceId);
      yield* instance?.invalidateCaches ?? Effect.void;
      yield* registry.refreshInstance(owner.instanceId);
    },
    Effect.ignoreCause({ log: true }),
  );

  const retryAfter = Effect.fnUntraced(function* (credit: Candidate) {
    attempts.set(credit.key, { credit, retryAt: (yield* Clock.currentTimeMillis) + MINUTE });
  });

  const readSettings = settings.getSettings.pipe(Effect.orElseSucceed(() => null));
  const attempt = Effect.fn("ResetCreditExpiry.attempt")(function* (credit: Candidate) {
    const { owner } = credit;
    const instance =
      "instanceId" in owner ? yield* instances.getInstance(owner.instanceId) : undefined;
    const initialSettings = yield* readSettings;
    if (!initialSettings?.autoUseExpiringResetCredits) return;
    const now = yield* Clock.currentTimeMillis;
    const previous = attempts.get(credit.key);
    if (
      now < credit.opens ||
      now > credit.closes ||
      (previous && (previous.credit.signature !== credit.signature || previous.retryAt > now))
    )
      return;

    // Keep the same redemption path after an unanswered request, even if another report takes over.
    attempts.set(credit.key, { credit, retryAt: Infinity });
    if ("instanceId" in owner && (!instance?.enabled || !instance.consumeResetCredit)) {
      yield* retryAfter(credit);
      return;
    }
    const automatic = {
      ...credit,
      canRedeem: Effect.gen(function* () {
        if (
          !(yield* selections).selected.some(
            (current) => current.key === credit.key && current.signature === credit.signature,
          )
        )
          return false;
        if ("instanceId" in owner) {
          if (!instance || (yield* instances.getInstance(owner.instanceId)) !== instance)
            return false;
          const current = yield* instance.snapshot.getSnapshot;
          const selected = current.usageLimits?.resetCredits;
          if (
            current.auth.status !== "authenticated" ||
            current.auth.email?.trim().toLowerCase() !== credit.email ||
            current.auth.workspaceId !== credit.workspaceId ||
            current.usageLimits?.unavailable ||
            !selected?.availableCount ||
            selected.nextCreditId !== credit.creditId ||
            selected.nextExpiresAt !== credit.expiresAt
          )
            return false;
        }
        const latest = yield* readSettings;
        if (!latest?.autoUseExpiringResetCredits) return false;
        if (
          "instanceId" in owner &&
          !Equal.equals(
            initialSettings.providerInstances[owner.instanceId],
            latest.providerInstances[owner.instanceId],
          )
        )
          return false;
        if (
          "sourceId" in owner &&
          !Equal.equals(
            initialSettings.usageLimitSources[owner.sourceId],
            latest.usageLimitSources[owner.sourceId],
          )
        )
          return false;
        const currentTime = yield* Clock.currentTimeMillis;
        return currentTime >= credit.opens && currentTime <= credit.closes;
      }),
    } satisfies AutomaticResetCredit;
    const outcome = yield* (
      "sourceId" in owner
        ? sources
            .consumeResetCredit(
              { sourceId: owner.sourceId, accountId: owner.accountId, creditId: credit.creditId },
              { ...automatic, endpoint: owner.endpoint },
            )
            .pipe(Effect.map((result) => result.outcome))
        : (instance?.consumeResetCredit?.(automatic) ?? Effect.succeed("nothingToReset" as const))
    ).pipe(Effect.result);
    const status = outcome._tag === "Success" ? outcome.success : "unconfirmed";
    yield* Effect.logInfo("Automatic reset credit attempt", {
      owner,
      creditId: credit.creditId,
      status,
    });
    yield* refreshOwner(owner);
    yield* retryAfter(credit);
  });

  const run = Effect.gen(function* () {
    yield* Stream.mergeAll(
      [
        registry.streamChanges.pipe(Stream.as(undefined)),
        instances.streamChanges.pipe(Stream.as(undefined)),
        sources.streamChanges.pipe(Stream.as(undefined)),
        settings.streamChanges.pipe(
          Stream.map((value) => value.autoUseExpiringResetCredits),
          Stream.changes,
          Stream.as(undefined),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() => Queue.offer(changes, undefined)),
      Effect.forkScoped,
    );

    yield* Effect.forever(
      Effect.gen(function* () {
        const enabled = (yield* readSettings)?.autoUseExpiringResetCredits;
        const now = yield* Clock.currentTimeMillis;
        const due: Effect.Effect<void>[] = [];
        let next = Infinity;
        if (enabled) {
          const { selected, unknown } = yield* selections;
          for (const credit of selected) {
            const previous = attempts.get(credit.key);
            if (previous && previous.credit.signature !== credit.signature) continue;
            const at = Math.max(credit.opens, previous?.retryAt ?? 0);
            if (Math.max(at, now) > credit.closes) continue;
            if (at <= now) due.push(attempt(credit));
            else next = Math.min(next, at);
          }
          for (const { credit, retryAt } of attempts.values()) {
            if (!unknown.has(credit.ownerKey) || Math.max(retryAt, now) > credit.closes) continue;
            if (retryAt <= now)
              due.push(refreshOwner(credit.owner).pipe(Effect.andThen(retryAfter(credit))));
            else next = Math.min(next, retryAt);
          }
        }
        if (due.length > 0) {
          yield* Effect.all(due, { concurrency: 4, discard: true });
        } else if (Number.isFinite(next)) {
          yield* Effect.raceFirst(Queue.take(changes), Effect.sleep(next - now));
        } else {
          yield* Queue.take(changes);
        }
      }),
    );
  });
  yield* forkParked(run);
});

export const layer = Layer.effectDiscard(start);
