import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export const SIDEBAR_USAGE_DRIVERS = ["codex", "claudeAgent"] as const;
export type SidebarUsageDriver = (typeof SIDEBAR_USAGE_DRIVERS)[number];
export type SidebarUsage = Readonly<Partial<Record<SidebarUsageDriver, number>>>;

/** Sum the existing estimates, including fractions and estimates over 100%, before formatting. */
export function sumSidebarProjectUsage(
  threads: readonly (Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "providerInstanceId"
  > & { readonly source: Pick<EnvironmentThreadShell["source"], "usageSummary"> })[],
  driverByProviderKey: ReadonlyMap<string, string>,
): ReadonlyMap<string, SidebarUsage> {
  const sums = new Map<string, Partial<Record<SidebarUsageDriver, number>>>();
  for (const thread of threads) {
    const driver = driverByProviderKey.get(`${thread.environmentId}:${thread.providerInstanceId}`);
    const percent = thread.source.usageSummary?.weeklyLimitPercent;
    if (
      (driver !== "codex" && driver !== "claudeAgent") ||
      percent === undefined ||
      !Number.isFinite(percent) ||
      percent < 0
    )
      continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    let sum = sums.get(key);
    if (!sum) {
      sum = {};
      sums.set(key, sum);
    }
    sum[driver] = (sum[driver] ?? 0) + percent;
  }
  return sums;
}

/** A logical project can include several physical projects or environments. */
export function selectSidebarUsage(
  sums: ReadonlyMap<string, SidebarUsage>,
  projectKeys: ReadonlySet<string>,
  remaining = false,
): SidebarUsage {
  const total: Partial<Record<SidebarUsageDriver, number>> = {};
  const selected = remaining
    ? [...sums].filter(([key]) => !projectKeys.has(key)).map(([, sum]) => sum)
    : [...projectKeys].map((key) => sums.get(key));
  for (const sum of selected) {
    if (!sum) continue;
    for (const driver of SIDEBAR_USAGE_DRIVERS) {
      const percent = sum[driver];
      if (percent !== undefined) total[driver] = (total[driver] ?? 0) + percent;
    }
  }
  return total;
}

export function sameSidebarUsage(left: SidebarUsage, right: SidebarUsage): boolean {
  return SIDEBAR_USAGE_DRIVERS.every((driver) => left[driver] === right[driver]);
}

export function remainingToUsedPercent(remaining: number | null | undefined): number | null {
  return remaining == null || !Number.isFinite(remaining) ? null : 100 - remaining;
}

export function sidebarUsedClass(used: number): string {
  if (used < 30) return "text-emerald-500";
  if (used < 70) return "text-amber-500";
  return "text-red-500";
}

export function formatSidebarUsage(used: number | undefined): string {
  return used === undefined ? "—" : `${Math.floor(used)}%`;
}
