import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import {
  resolveThreadActivityGroup,
  threadActivityFromShell,
  threadQuietMinutes,
} from "./threadActivity.ts";

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
  expect(threadQuietMinutes(thread, { ...clock, quietMinutes: 0 })).toBeNull();
});

it("leaves linked-environment workers out of quiet detection", () => {
  const shell = {
    status: "running",
    updatedAt: DateTime.makeUnsafe(0),
    lastProviderActivityAt: 0,
    pendingRuntimeRequest: null,
    latestRunId: null,
  } as OrchestrationV2ThreadShell;
  const clock = { nowMs: 600_000, quietMinutes: 10 };
  expect(threadQuietMinutes(threadActivityFromShell(shell), clock)).toBe(10);
  expect(
    threadQuietMinutes(
      threadActivityFromShell({
        ...shell,
        delegatedFrom: {
          environmentId: EnvironmentId.make("linked"),
          threadId: ThreadId.make("parent"),
          title: "Parent",
        },
      }),
      clock,
    ),
  ).toBeNull();
});
