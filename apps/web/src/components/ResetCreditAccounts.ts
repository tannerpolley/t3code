import type {
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

export interface ResetCreditAccount {
  readonly key: string;
  readonly label: string;
  readonly limits: ServerProviderUsageLimits;
  readonly input: ProviderConsumeResetCreditInput;
}

const providerLabel = (driver: string) =>
  driver === "codex" ? "Codex" : driver === "claudeAgent" ? "Claude Code" : driver;

export function collectResetCreditAccounts(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): readonly ResetCreditAccount[] {
  const accounts = new Map<string, ResetCreditAccount>();
  for (const provider of providers) {
    if (
      !provider.enabled ||
      !provider.usageLimits ||
      (!provider.usageLimits.resetCredits?.expiries?.length &&
        !provider.usageLimits.resetCreditAutoUse)
    )
      continue;
    const identity =
      provider.usageLimits.credentialFingerprint ??
      provider.auth.profileId ??
      provider.auth.email ??
      provider.instanceId;
    const key = `${provider.driver}:${identity}:${provider.auth.workspaceId ?? ""}`;
    if (!accounts.has(key))
      accounts.set(key, {
        key,
        label: provider.displayName ?? providerLabel(provider.driver),
        limits: provider.usageLimits,
        input: {
          instanceId: provider.instanceId,
          ...(provider.usageLimits.resetCredits?.nextCreditId
            ? { creditId: provider.usageLimits.resetCredits.nextCreditId }
            : {}),
        },
      });
  }
  for (const source of sources) {
    for (const account of source.accounts) {
      const key = `${account.driver}:${account.email ?? `${source.id}/${account.id}`}:${account.workspaceId ?? ""}`;
      const existing = accounts.get(key);
      if (existing) {
        const result = account.usageLimits.resetCreditAutoUse;
        if (
          result &&
          (!existing.limits.resetCreditAutoUse ||
            result.attemptedAt > existing.limits.resetCreditAutoUse.attemptedAt)
        ) {
          accounts.set(key, {
            ...existing,
            limits: { ...existing.limits, resetCreditAutoUse: result },
          });
        }
        continue;
      }
      const creditId =
        account.usageLimits.resetCredits?.nextCreditId ??
        account.usageLimits.resetCreditAutoUse?.creditId;
      if (!creditId) continue;
      accounts.set(key, {
        key,
        label: providerLabel(account.driver),
        limits: account.usageLimits,
        input: { sourceId: source.id, accountId: account.id, creditId },
      });
    }
  }
  return [...accounts.values()];
}
