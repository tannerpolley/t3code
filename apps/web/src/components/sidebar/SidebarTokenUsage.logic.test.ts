import { describe, expect, it } from "vite-plus/test";
import { formatSidebarTokens } from "./SidebarTokenUsage.logic";

describe("sidebar token formatting", () => {
  it("formats zero, unavailable counts, and rounded thousand/million boundaries", () => {
    expect(
      [undefined, 0, 999, 1_000, 48_123, 999_499, 999_500, 1_250_000, 10_000_000].map(
        formatSidebarTokens,
      ),
    ).toEqual(["—", "0", "999", "1k", "48k", "999k", "1M", "1.3M", "10M"]);
  });
});
