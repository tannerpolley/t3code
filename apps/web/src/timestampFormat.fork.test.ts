import { getTranslationsSnapshot, initializeGT } from "gt-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getActiveLocale, setActiveLocale } from "./i18n/messages";
import ja from "./i18n/translations/ja.json";
import {
  formatCompactElapsedSeconds,
  formatElapsedSeconds,
  formatExpiresInLabel,
} from "./timestampFormat";

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

  it("uses Japanese duration units while preserving padding and compact thresholds", async () => {
    initializeGT({
      defaultLocale: "en",
      locales: ["en", "ja"],
      loadTranslations: async (locale) => (locale === "ja" ? ja : {}),
    });
    await getTranslationsSnapshot("ja");
    const previous = getActiveLocale();
    using _locale = { [Symbol.dispose]: () => setActiveLocale(previous) };
    setActiveLocale("ja");

    expect(formatElapsedSeconds(65)).toBe("01分05秒");
    expect(formatElapsedSeconds(24 * 3600)).toBe("01日00時間");
    expect(formatCompactElapsedSeconds(90)).toBe("1分");
    expect(formatCompactElapsedSeconds(1000 * 24 * 60 * 60)).toBe("2.7年");
  });
});
