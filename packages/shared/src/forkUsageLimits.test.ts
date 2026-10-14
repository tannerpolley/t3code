import { UsageDay, type ServerProviderUsageWindow, type UsageBucket } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { isUsageWindowStale, weeklyLimitPercentPerUsd } from "./forkUsageLimits.ts";

it("treats a passed reset as unknown even when the duration is missing", () => {
  const window = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 99,
    resetsAt: "2026-10-13T12:00:00.000Z",
  } as const;
  expect(isUsageWindowStale(window, Date.parse(window.resetsAt) - 1)).toBe(false);
  expect(isUsageWindowStale(window, Date.parse(window.resetsAt))).toBe(true);
  expect(isUsageWindowStale({ ...window, resetsAt: undefined }, Date.parse(window.resetsAt))).toBe(
    false,
  );
});

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function bucket(hoursAgo: number, costUsd: number, priced = true): UsageBucket {
  return {
    day: UsageDay.make("2026-09-23"),
    hourStart: DateTime.formatIso(DateTime.makeUnsafe(NOW - hoursAgo * HOUR)),
    provider: "codex",
    model: "gpt-a",
    totals: {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: priced ? "modelPriced" : "unpriced",
    records: 1,
    unpricedRecords: priced ? 0 : 1,
    sessions: 1,
  };
}

// The week opened six days ago and resets tomorrow.
const weekly: ServerProviderUsageWindow = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  resetsAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + 24 * HOUR)),
  windowDurationMins: 7 * 24 * 60,
};
const factor = (window: ServerProviderUsageWindow, buckets: readonly UsageBucket[]) =>
  weeklyLimitPercentPerUsd({ window, buckets, provider: "codex", nowMs: NOW, timeZone: "UTC" });

describe("weeklyLimitPercentPerUsd", () => {
  it("divides the window's reported percent by what its usage cost", () => {
    // $10 + $30 inside the week; the $50 from eight days ago is before it.
    expect(factor(weekly, [bucket(2, 10), bucket(30, 30), bucket(8 * 24, 50)])).toBe(0.5);
  });

  it("is unknown without a window clock or any priced usage", () => {
    expect(factor({ ...weekly, resetsAt: undefined }, [bucket(2, 10)])).toBeNull();
    expect(factor(weekly, [bucket(2, 0, false)])).toBeNull();
    expect(factor(weekly, [])).toBeNull();
    expect(
      factor({ ...weekly, resetsAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)) }, [
        bucket(2, 10),
      ]),
    ).toBeNull();
  });
});
