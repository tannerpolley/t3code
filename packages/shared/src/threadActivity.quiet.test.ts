import { expect, it } from "vite-plus/test";
import { resolveThreadActivityGroup, threadQuietMinutes } from "./threadActivity.ts";

it("puts a quiet running thread in Needs you after the configured interval", () => {
  const lastProviderActivityAt = Date.parse("2026-11-18T12:00:00Z");
  const thread = {
    lastProviderActivityAt,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestRun: null,
    runtime: { status: "running" },
    pullRequests: [],
  } as const;
  const clock = { nowMs: lastProviderActivityAt + 600_000, quietMinutes: 10 };
  expect(resolveThreadActivityGroup(thread, { ...clock, nowMs: clock.nowMs - 1 })).toBe("working");
  expect(resolveThreadActivityGroup(thread, clock)).toBe("needs-you");
  expect(threadQuietMinutes({ ...thread, hasActiveProviderWork: true }, clock)).toBeNull();
  expect(threadQuietMinutes({ ...thread, hasPendingUserInput: true }, clock)).toBeNull();
  expect(threadQuietMinutes({ ...thread, hasPendingApprovals: true }, clock)).toBeNull();
  expect(threadQuietMinutes(thread, { ...clock, quietMinutes: 15 })).toBeNull();
});
