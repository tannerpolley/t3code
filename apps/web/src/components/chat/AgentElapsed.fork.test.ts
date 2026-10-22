import { expect, it } from "vite-plus/test";

import { formatCompactElapsedSeconds } from "./AgentElapsed";

it.each([
  [45, "45s"],
  [90, "1m"],
  [59 * 60 + 59, "59m"],
  [60 * 60, "1h"],
  [90 * 60, "1.5h"],
  [119 * 60, "1.9h"],
  [14 * 60 * 60 + 40 * 60, "14h"],
  [999 * 60 * 60, "999h"],
  [1000 * 60 * 60, "41d"],
  [1000 * 24 * 60 * 60, "2.7y"],
  [1000 * 365 * 24 * 60 * 60, ">99y"],
  [Infinity, "0s"],
])("formats %ss as %s", (seconds, label) => {
  expect(formatCompactElapsedSeconds(seconds)).toBe(label);
});
