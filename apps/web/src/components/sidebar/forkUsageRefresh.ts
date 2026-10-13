import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";

import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";

const refreshAfter = new Map<EnvironmentId, number>();

/** Focus and visibility often arrive together; share the existing in-flight limits refresh. */
export function refreshSidebarUsage<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  now = Date.now(),
): Promise<A | undefined> {
  if (automatic && now < (refreshAfter.get(environmentId) ?? 0)) return Promise.resolve(undefined);
  refreshAfter.set(environmentId, now + 30_000);
  return refreshUsageLimits(environmentId, refresh);
}

/** A recent live reading already caught us up; cached data keeps its original timestamp. */
export function sidebarUsageProvidersToRefresh(
  providers: readonly ServerProvider[],
  now: number,
  automatic = true,
): readonly ServerProvider[] {
  return providers.filter((provider) => {
    if (!provider.enabled || (provider.driver !== "claudeAgent" && provider.driver !== "codex"))
      return false;
    if (!automatic) return true;
    const limits = provider.usageLimits;
    return (
      Date.parse(limits?.checkedAt ?? provider.checkedAt) <= now - 30_000 ||
      limits?.windows.some((window) => isUsageWindowStale(window, now)) === true
    );
  });
}
