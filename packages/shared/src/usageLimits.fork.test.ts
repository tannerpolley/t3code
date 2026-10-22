import { describe, expect, it } from "vite-plus/test";

import { formatResetsIn } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

describe("pace", () => {
  it.each([
    ["2026-09-03T12:01:00.000Z", "resets in 1m"],
    ["2026-09-03T12:00:59.999Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.001Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.000Z", "Stale · refresh usage"],
    ["2026-09-03T11:59:59.999Z", "Stale · refresh usage"],
  ])("formats the reset boundary at %s", (resetsAt, label) => {
    expect(formatResetsIn({ ...window, resetsAt }, now)).toBe(label);
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "Stale · refresh usage",
    );
  });
});
