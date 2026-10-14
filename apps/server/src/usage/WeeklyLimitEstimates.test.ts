import { describe, expect, it } from "vite-plus/test";

import {
  threadWeeklyLimitEstimate,
  type WeeklyLimitEstimateInputs,
} from "./WeeklyLimitEstimates.ts";

const totals = (outputTokens: number) => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens,
  reasoningTokens: 0,
});
// A dollar per thousand output tokens for priced models.
const inputs: WeeklyLimitEstimateInputs = {
  priceTokens: (model, tokens) => (model.startsWith("priced") ? tokens.outputTokens / 1_000 : null),
  percentPerUsd: new Map([["codex", 0.5]]),
};

describe("threadWeeklyLimitEstimate", () => {
  it("sums the thread's cost across its models on its current instance", () => {
    const rows = [
      { instanceId: "codex", model: "priced-a", totals: totals(2_000) },
      { instanceId: "codex", model: "priced-b", totals: totals(4_000) },
      // Runs on another account count against that account's limit, not this one.
      { instanceId: "codex-work", model: "priced-a", totals: totals(9_000) },
    ];
    expect(threadWeeklyLimitEstimate(rows, "codex", inputs)).toEqual({
      costUsd: 6,
      weeklyLimitPercent: 3,
    });
  });

  it("gives no share while the instance's factor is unknown", () => {
    const rows = [{ instanceId: "claude", model: "priced-a", totals: totals(2_000) }];
    expect(threadWeeklyLimitEstimate(rows, "claude", inputs)).toEqual({ costUsd: 2 });
    expect(threadWeeklyLimitEstimate(rows, "claude", null)).toBeUndefined();
  });

  it("gives nothing when any model has no price", () => {
    const rows = [
      { instanceId: "codex", model: "priced-a", totals: totals(2_000) },
      { instanceId: "codex", model: "custom", totals: totals(2_000) },
    ];
    expect(threadWeeklyLimitEstimate(rows, "codex", inputs)).toBeUndefined();
  });
});
