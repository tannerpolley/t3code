import { useEffect } from "react";
import { act, render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { useSettingsRestore } from "./SettingsPanels";

async function renderRestore() {
  let restore!: ReturnType<typeof useSettingsRestore>;
  function Probe() {
    const result = useSettingsRestore();
    useEffect(() => {
      restore = result;
    });
    return null;
  }
  const screen = await render(<Probe />);
  return {
    ...screen,
    get restore() {
      return restore;
    },
  };
}
function setup() {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
}

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context", true],
    ["usageLimitRecovery", "Usage limit recovery", "switch"],
    [
      "usageLimitFallbackModels",
      "Usage limit fallback models",
      [{ instanceId: "codex", model: "gpt-6.1-sol" }],
    ],
    ["autoResumeLimitedThreads", "Auto-resume limited threads", true],
    ["snoozeLimitedThreads", "Snooze limited threads", true],
  ] as const)("restores %s when it is the only changed setting", async (key, label, value) => {
    setup();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value };
    await using screen = await renderRestore();
    const { restore } = screen;

    expect(restore.changedSettingLabels).toEqual([label]);
    await act(() => restore.restoreDefaults());

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });
});
