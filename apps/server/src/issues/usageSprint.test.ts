import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryUsageSprint,
  type ServerProvider,
} from "@t3tools/contracts";

import { usageSprintCheck } from "./usageSprint.ts";

const resetsAt = "2026-11-13T23:31:57.000Z";
const sprint: RepositoryUsageSprint = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  windowId: "weekly",
  usedPercent: 40,
  resetsAt,
  startedAt: "2026-11-09T00:00:00.000Z",
};
const provider = (window: { usedPercent: number; resetsAt: string }): ServerProvider => ({
  instanceId: sprint.providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-10T00:00:00.000Z",
    windows: [
      { id: "session", kind: "session", label: "Session", usedPercent: 0, resetsAt },
      { id: "weekly", kind: "weekly", label: "Weekly", ...window },
    ],
  },
});
const before = Date.parse(resetsAt) - 60 * 60_000;

it.each([
  {
    name: "usage grows, same reset",
    window: { usedPercent: 70, resetsAt },
    now: before,
    result: { peak: 70 },
  },
  {
    name: "probe jitter on the reset time",
    window: { usedPercent: 41, resetsAt: "2026-11-13T23:31:57.456Z" },
    now: before,
    result: { peak: 41 },
  },
  { name: "no usage data", window: undefined, now: before, result: { peak: 40 } },
  {
    name: "scheduled reset passes",
    window: undefined,
    now: Date.parse(resetsAt),
    result: { end: "reset" },
  },
  {
    name: "reset credit moves the reset",
    window: { usedPercent: 0, resetsAt: "2026-11-17T00:00:00.000Z" },
    now: before,
    result: { end: "early_reset" },
  },
  {
    name: "usage drops back before the reset moves",
    window: { usedPercent: 2, resetsAt },
    now: before,
    result: { end: "early_reset" },
  },
] as const)("checks a sprint when $name", ({ window, now, result }) => {
  assert.deepEqual(
    usageSprintCheck(sprint, window === undefined ? undefined : provider(window), now),
    result,
  );
});
