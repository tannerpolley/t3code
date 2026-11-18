import { resolveThreadActivityGroup } from "@t3tools/shared/threadActivity";

export const SIDEBAR_ACTIVITY_GROUPS = ["needs-you", "ready-for-review"] as const;
export type SidebarActivityGroup = (typeof SIDEBAR_ACTIVITY_GROUPS)[number];

export function isSidebarActivityGroup(section: string): section is SidebarActivityGroup {
  return section === "needs-you" || section === "ready-for-review";
}

export function resolveSidebarActivityGroup(
  thread: Parameters<typeof resolveThreadActivityGroup>[0],
): SidebarActivityGroup | null {
  const group = resolveThreadActivityGroup(thread);
  return group === "working" ? null : group;
}
