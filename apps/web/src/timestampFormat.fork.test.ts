import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatElapsedSeconds, formatExpiresInLabel } from "./timestampFormat";

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });
});

describe("formatElapsedSeconds", () => {
  it.each([
    [0, "00m 00s"],
    [65, "01m 05s"],
    [3599, "59m 59s"],
    [3600, "01h 00m 00s"],
    [99 * 3600, "99h 00m 00s"],
    [100 * 3600, "4d 04h 00m"],
    [123 * 3600, "5d 03h 00m"],
    [12 * 3600 + 4 * 60, "12h 04m 00s"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatElapsedSeconds(seconds)).toBe(expected);
  });
});
