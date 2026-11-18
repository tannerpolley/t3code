import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveThreadActivity } from "@t3tools/client-runtime/state/thread-activity";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

export const SIDEBAR_ACTIVITY_GROUPS = ["needs-you", "ready-for-review"] as const;
export type SidebarActivityGroup = (typeof SIDEBAR_ACTIVITY_GROUPS)[number];

export function isSidebarActivityGroup(section: string): section is SidebarActivityGroup {
  return section === "needs-you" || section === "ready-for-review";
}

export function resolveSidebarActivityGroup(
  thread: Parameters<typeof isThreadWorking>[0] & Pick<EnvironmentThreadShell, "pullRequests">,
): SidebarActivityGroup | null {
  const activity = resolveThreadActivity(thread);
  if (
    activity === "approval" ||
    activity === "input" ||
    activity === "failed" ||
    activity === "limited"
  ) {
    return "needs-you";
  }
  if (
    thread.pullRequests.some(
      (pr) => pr.source !== "stack-dismissed" && pr.snapshot?.state === "open",
    ) &&
    !isThreadWorking(thread)
  ) {
    return "ready-for-review";
  }
  return null;
}
