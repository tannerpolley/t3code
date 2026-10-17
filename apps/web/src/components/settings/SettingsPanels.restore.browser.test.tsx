import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let root: Root;
let restore: ReturnType<typeof useSettingsRestore>;

function Probe() {
  const result = useSettingsRestore();
  useEffect(() => {
    restore = result;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<Probe />));

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context", true],
    ["usageLimitRecovery", "Usage limit recovery", "switch"],
    [
      "usageLimitFallbackModels",
      "Usage limit fallback models",
      [{ instanceId: "codex", model: "gpt-6.1-sol" }],
    ],
  ] as const)("restores %s when it is the only changed setting", async (key, label, value) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value };
    await render();

    expect(restore.changedSettingLabels).toEqual([label]);
    await act(() => restore.restoreDefaults());

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, usageLimitRecovery: "switch" };
    state.confirm.mockResolvedValue(false);
    await render();

    await act(() => restore.restoreDefaults());

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
