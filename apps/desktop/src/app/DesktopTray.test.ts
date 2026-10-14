import { describe, expect, it } from "vite-plus/test";

import { mainWindowCloseAction } from "./DesktopTray.ts";

const keepRunning = {
  platform: "linux",
  quitting: false,
  trayShown: true,
  keepRunningInBackground: true,
} as const;

describe("mainWindowCloseAction", () => {
  it.each([
    ["hides on Linux while the tray is shown", keepRunning, "hide"],
    ["hides on Windows while the tray is shown", { ...keepRunning, platform: "win32" }, "hide"],
    ["closes when the setting is off", { ...keepRunning, keepRunningInBackground: false }, "close"],
    [
      "closes without a tray, so the app is never unreachable",
      { ...keepRunning, trayShown: false },
      "close",
    ],
    [
      "closes during a quit, so it never blocks quitting",
      { ...keepRunning, quitting: true },
      "close",
    ],
    ["leaves macOS unchanged", { ...keepRunning, platform: "darwin" }, "close"],
  ] as const)("%s", (_name, input, expected) => {
    expect(mainWindowCloseAction(input)).toBe(expected);
  });
});
