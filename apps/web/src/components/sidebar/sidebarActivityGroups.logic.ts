import { toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { resolveThreadActivityGroup, type ThreadQuietClock } from "@t3tools/shared/threadActivity";

export const SIDEBAR_ACTIVITY_GROUPS = ["needs-you", "ready-for-review"] as const;
export type SidebarActivityGroup = (typeof SIDEBAR_ACTIVITY_GROUPS)[number];

export function isSidebarActivityGroup(section: string): section is SidebarActivityGroup {
  return section === "needs-you" || section === "ready-for-review";
}

export function sidebarQuietClock(
  environmentId: EnvironmentId,
  nowMs: number,
  quietMinutes = DEFAULT_SERVER_SETTINGS.quietThreadMinutes,
): ThreadQuietClock {
  return { nowMs: toServerClock(environmentId, nowMs), quietMinutes };
}

export function resolveSidebarActivityGroup(
  thread: Parameters<typeof resolveThreadActivityGroup>[0],
  clock?: ThreadQuietClock,
): SidebarActivityGroup | null {
  const group = resolveThreadActivityGroup(thread, clock);
  return group === "working" ? null : group;
}
