import { describe, expect, it } from "vite-plus/test";

import { shouldOfferResumeCompaction } from "./ContextWindowMeter.logic";

describe("shouldOfferResumeCompaction", () => {
  const now = "2026-08-24T12:00:00.000Z";

  it("offers idle Codex compaction from 100k tokens", () => {
    const input = { provider: "codex", updatedAt: "2026-08-24T10:50:00.000Z", now };
    expect(shouldOfferResumeCompaction({ ...input, usedTokens: 100_000 })).toBe(true);
    expect(shouldOfferResumeCompaction({ ...input, usedTokens: 99_999 })).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        ...input,
        usedTokens: 100_000,
        updatedAt: "2026-08-24T11:59:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not offer resume compaction for a provider outside this flow", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "cursor",
        usedTokens: 300_000,
        updatedAt: "2026-08-24T09:00:00.000Z",
        now,
      }),
    ).toBe(false);
  });
});
