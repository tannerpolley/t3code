import { UsageDay, type UsageBucket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attributeWindow, dayStartMs, OTHER_MODELS } from "./usageLimitModels";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function bucket(
  overrides: Partial<UsageBucket> & { readonly tokens?: number; readonly hoursAgo?: number },
): UsageBucket {
  const { tokens = 1_000, hoursAgo = 1, ...rest } = overrides;
  return {
    day: UsageDay.make("2026-09-23"),
    hourStart: new Date(NOW - hoursAgo * HOUR).toISOString(),
    provider: "codex",
    model: "gpt-a",
    totals: {
      uncachedInputTokens: tokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 1,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...rest,
  };
}

const window = { nowMs: NOW, startMs: NOW - 5 * HOUR, usedPercent: 40, timeZone: "UTC" };

describe("attributeWindow", () => {
  it("splits used percent by cost, only for the window's provider and span", () => {
    const result = attributeWindow({
      ...window,
      provider: "codex",
      buckets: [
        bucket({ model: "gpt-a", costUsd: 3 }),
        bucket({ model: "gpt-b", costUsd: 1, hoursAgo: 2 }),
        bucket({ model: "claude-x", provider: "claude", costUsd: 100 }),
        bucket({ model: "gpt-old", costUsd: 100, hoursAgo: 9 }),
      ],
    });
    expect(result?.models).toEqual([
      { model: "gpt-a", percent: 30 },
      { model: "gpt-b", percent: 10 },
    ]);
  });

  it("counts a bucket that straddles the window start by its share inside", () => {
    const result = attributeWindow({
      ...window,
      startMs: NOW - 1.5 * HOUR,
      provider: "codex",
      buckets: [bucket({ model: "gpt-a", hoursAgo: 1 }), bucket({ model: "gpt-b", hoursAgo: 2 })],
    });
    // gpt-b's hour is half inside the window.
    expect(result?.models[0]?.percent).toBeCloseTo(40 * (2 / 3));
    expect(result?.models[1]?.percent).toBeCloseTo(40 * (1 / 3));
  });

  it("weighs an unpriced model by tokens at the provider's priced rate", () => {
    const result = attributeWindow({
      ...window,
      provider: "codex",
      buckets: [
        bucket({ model: "gpt-a", costUsd: 2, tokens: 1_000 }),
        bucket({ model: "gpt-new", costUsd: 0, tokens: 1_000, unpricedRecords: 1 }),
      ],
    });
    expect(result?.models).toEqual([
      { model: "gpt-a", percent: 20 },
      { model: "gpt-new", percent: 20 },
    ]);
  });

  it("falls back to tokens when nothing in the window is priced", () => {
    const result = attributeWindow({
      ...window,
      provider: "codex",
      buckets: [
        bucket({ model: "gpt-a", costUsd: 0, tokens: 3_000, unpricedRecords: 1 }),
        bucket({ model: "gpt-b", costUsd: 0, tokens: 1_000, unpricedRecords: 1 }),
      ],
    });
    expect(result?.models.map((entry) => entry.percent)).toEqual([30, 10]);
  });

  it("folds the long tail into Other models and keeps per-period points summing to used", () => {
    const models = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const result = attributeWindow({
      ...window,
      provider: "codex",
      buckets: models.map((model, index) => bucket({ model, costUsd: 6 - index })),
    });
    expect(result?.models.map((entry) => entry.model)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      OTHER_MODELS,
    ]);
    const periodTotal = [...(result?.periods.values() ?? [])]
      .flat()
      .reduce((sum, value) => sum + value, 0);
    expect(periodTotal).toBeCloseTo(40);
  });

  it("prorates a daily bucket by the local day's time inside the window", () => {
    const start = dayStartMs("2026-09-22", "America/Denver");
    expect(new Date(start).toISOString()).toBe("2026-09-22T06:00:00.000Z");
    const result = attributeWindow({
      provider: "codex",
      usedPercent: 30,
      timeZone: "America/Denver",
      // Starts at local noon on the 22nd; the 23rd is still open at `now`.
      startMs: start + 12 * HOUR,
      nowMs: start + 36 * HOUR,
      buckets: [
        bucket({ model: "gpt-a", hourStart: undefined, day: UsageDay.make("2026-09-22") }),
        bucket({ model: "gpt-b", hourStart: undefined, day: UsageDay.make("2026-09-23") }),
      ],
    });
    expect(result?.models.map((entry) => entry.model)).toEqual(["gpt-b", "gpt-a"]);
    expect(result?.models[0]?.percent).toBeCloseTo(20);
    expect(result?.models[1]?.percent).toBeCloseTo(10);
  });

  it("returns null when the provider did nothing in the window", () => {
    expect(attributeWindow({ ...window, provider: "claude", buckets: [bucket({})] })).toBeNull();
  });
});
