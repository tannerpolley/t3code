import { describe, expect, it } from "vite-plus/test";

import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";

const convert = (resetCredits: Parameters<typeof codexRateLimitsToLimits>[0]["resetCredits"]) =>
  codexRateLimitsToLimits({ snapshot: {}, resetCredits, checkedAt: "2026-07-01T00:00:00.000Z" })
    .resetCredits;

describe("codexResetCreditsToContract", () => {
  it("counts available credits and reports the soonest expiry", () => {
    expect(
      convert({
        availableCount: 2,
        credits: [
          { status: "available", expiresAt: 1_784_500_000 },
          { status: "redeemed", expiresAt: 1_700_000_000 },
          { status: "available", expiresAt: 1_784_000_000 },
        ],
      }),
    ).toEqual({
      availableCount: 2,
      nextExpiresAt: "2026-07-14T03:33:20.000Z",
      expiries: ["2026-07-14T03:33:20.000Z", "2026-07-19T22:26:40.000Z"],
    });
    expect(convert({ availableCount: 0 })).toEqual({ availableCount: 0 });
    expect(convert(null)).toBeUndefined();
  });
});

it("pins the soonest available credit, excluding spent credits and credits without an expiry", () => {
  expect(
    convert({
      availableCount: 3,
      credits: [
        { id: "later", status: "available", expiresAt: 1_784_500_000 },
        { id: "spent", status: "redeemed", expiresAt: 1_700_000_000 },
        { id: "no-expiry", status: "available" },
        { id: "first", status: "available", expiresAt: 1_784_000_000 },
      ],
    })?.nextCreditId,
  ).toBe("first");
});
