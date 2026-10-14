import { describe, expect, it } from "vite-plus/test";
import { formatWeeklyLimitPercent } from "./SidebarTokenUsage.logic";

describe("weekly limit percent", () => {
  it("shows whole percents from 1%, rounded down, and nothing below or without an estimate", () => {
    expect([undefined, 0, 0.99, 1, 1.99, 12.7, 100].map(formatWeeklyLimitPercent)).toEqual([
      null,
      null,
      null,
      "1%",
      "1%",
      "12%",
      "100%",
    ]);
  });
});
