import type {
  ProviderInstanceId,
  ResetCreditAutoUseResult,
  ServerProvider,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";

export function resetCreditAccountKey(provider: ServerProvider): string {
  return [
    provider.driver,
    provider.usageLimits?.credentialFingerprint ??
      provider.auth.profileId ??
      provider.auth.email ??
      provider.instanceId,
    provider.auth.workspaceId,
  ]
    .map((part) => encodeURIComponent(part ?? ""))
    .join(":");
}

export const makeResetCreditExpiryResults = Effect.fn("ResetCreditExpiryResults.make")(function (
  providers: Ref.Ref<ReadonlyArray<ServerProvider>>,
  changes: PubSub.PubSub<ReadonlyArray<ServerProvider>>,
) {
  return Effect.sync(() => {
    const results = new Map<string, ResetCreditAutoUseResult>();
    const decorate = (provider: ServerProvider): ServerProvider => {
      const result = results.get(resetCreditAccountKey(provider));
      return result && provider.usageLimits
        ? { ...provider, usageLimits: { ...provider.usageLimits, resetCreditAutoUse: result } }
        : provider;
    };
    const publish = Effect.fn("ResetCreditExpiryResults.publish")(function* (
      instanceId: ProviderInstanceId,
      accountKey: string,
      result: ResetCreditAutoUseResult,
    ) {
      const current = yield* Ref.get(providers);
      if (
        !current.some(
          (provider) =>
            provider.instanceId === instanceId && resetCreditAccountKey(provider) === accountKey,
        )
      )
        return;
      results.set(accountKey, result);
      const next = yield* Ref.updateAndGet(providers, (values) => values.map(decorate));
      yield* PubSub.publish(changes, next);
    });
    return { decorate, publish };
  });
});

export function resetCreditSourceAccountKey(
  sourceId: string,
  account: UsageLimitSourceAccount,
): string {
  return [account.driver, account.email ?? `${sourceId}/${account.id}`, account.workspaceId]
    .map((part) => encodeURIComponent(part ?? ""))
    .join(":");
}

export const makeSourceResetCreditExpiryResults = Effect.fn("ResetCreditExpiryResults.makeSources")(
  function (
    snapshots: Ref.Ref<ReadonlyArray<UsageLimitSourceSnapshot>>,
    changes: PubSub.PubSub<ReadonlyArray<UsageLimitSourceSnapshot>>,
  ) {
    return Effect.sync(() => {
      const results = new Map<string, ResetCreditAutoUseResult>();
      const decorate = (source: UsageLimitSourceSnapshot) => ({
        ...source,
        accounts: source.accounts.map((account) => {
          const result = results.get(resetCreditSourceAccountKey(source.id, account));
          return result
            ? { ...account, usageLimits: { ...account.usageLimits, resetCreditAutoUse: result } }
            : account;
        }),
      });
      const publish = Effect.fn("ResetCreditExpiryResults.publishSource")(function* (
        sourceId: UsageLimitSourceId,
        accountId: string,
        accountKey: string,
        result: ResetCreditAutoUseResult,
      ) {
        const current = yield* Ref.get(snapshots);
        if (
          !current.some(
            (source) =>
              source.id === sourceId &&
              source.accounts.some(
                (account) =>
                  account.id === accountId &&
                  resetCreditSourceAccountKey(sourceId, account) === accountKey,
              ),
          )
        )
          return;
        results.set(accountKey, result);
        const next = yield* Ref.updateAndGet(snapshots, (values) => values.map(decorate));
        yield* PubSub.publish(changes, next);
      });
      return { decorate, publish };
    });
  },
);
