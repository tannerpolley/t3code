import type { ServerProviderUsageWindow } from "@t3tools/contracts";

/** A passed reset says nothing about the new allowance until the provider reads it again. */
export function isUsageWindowStale(window: ServerProviderUsageWindow, now: number): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now;
}
