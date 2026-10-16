import { expect, it } from "vite-plus/test";
import { isUsageWindowStale } from "./forkUsageLimits.ts";

it("treats a passed reset as unknown even when the duration is missing", () => {
  const window = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 99,
    resetsAt: "2026-10-13T12:00:00.000Z",
  } as const;
  expect(isUsageWindowStale(window, Date.parse(window.resetsAt) - 1)).toBe(false);
  expect(isUsageWindowStale(window, Date.parse(window.resetsAt))).toBe(true);
  expect(isUsageWindowStale({ ...window, resetsAt: undefined }, Date.parse(window.resetsAt))).toBe(
    false,
  );
});
