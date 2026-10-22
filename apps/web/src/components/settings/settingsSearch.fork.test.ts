import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

describe("searchSettings", () => {
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
