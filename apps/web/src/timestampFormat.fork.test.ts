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
    [3600, "01h 00m"],
    [12 * 3600 + 4 * 60 + 59, "12h 04m"],
    [24 * 3600 - 1, "23h 59m"],
    [24 * 3600, "01d 00h"],
    [123 * 3600 + 59 * 60, "05d 03h"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatElapsedSeconds(seconds)).toBe(expected);
  });
});
