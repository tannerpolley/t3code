import { getTranslationsSnapshot, initializeGT } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import { getActiveLocale, m, setActiveLocale } from "../../i18n/messages";
import ja from "../../i18n/translations/ja.json";
import { searchSettings } from "./settingsSearch";

describe("searchSettings", () => {
  it("finds the worktree location by its Japanese and fork-specific keywords", async () => {
    initializeGT({
      defaultLocale: "en",
      locales: ["en", "ja"],
      loadTranslations: async (locale) => (locale === "ja" ? ja : {}),
    });
    await getTranslationsSnapshot("ja");
    const previous = getActiveLocale();
    using _locale = { [Symbol.dispose]: () => setActiveLocale(previous) };
    setActiveLocale("ja");

    for (const query of ["外付け", "inside project local .worktrees"]) {
      expect(searchSettings(query, undefined, m).map((item) => item.id)).toContain(
        "storage-worktrees-location",
      );
    }
  });
  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar").map((item) => item.id)).toContain(
      "keybinding-sidebar.toggle",
    );
    expect(searchSettings("sidebar toggle position")[0]?.id).toBe("sidebar-toggle-position");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    expect(ids.indexOf("keybinding-modelPicker.toggle")).toBeGreaterThan(
      ids.indexOf("default-model"),
    );
    expect(ids.indexOf("keybinding-modelPicker.toggle")).toBeGreaterThan(
      ids.indexOf("text-generation-model"),
    );
  });
});
