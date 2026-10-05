import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupProviderPlugins } from "./CustomizationsSettings.logic";

const provider = (
  id: string,
  displayName: string,
  plugins?: ReadonlyArray<{ name: string; skillCount: number; requiresDesktopApp?: boolean }>,
  enabled = true,
) => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  displayName,
  enabled,
  ...(plugins ? { plugins } : {}),
});

describe("groupProviderPlugins", () => {
  it("is null until an enabled provider reports a plugin list", () => {
    expect(groupProviderPlugins([provider("codex", "Codex")])).toBeNull();
    expect(groupProviderPlugins([provider("codex", "Codex", [], false)])).toBeNull();
    expect(groupProviderPlugins([provider("codex", "Codex", [])])).toEqual([]);
  });

  it("groups by provider label, sorts by name and folds away plugins without usable skills", () => {
    const groups = groupProviderPlugins([
      provider("codex", "Codex", [
        { name: "vercel", skillCount: 3 },
        { name: "figma", skillCount: 4, requiresDesktopApp: true },
        { name: "github", skillCount: 2 },
        { name: "empty", skillCount: 0 },
      ]),
      provider("claudeAgent", "Claude", [{ name: "ponytail", skillCount: 5 }]),
    ]);
    expect(
      groups?.map((group) => ({
        label: group.label,
        available: group.available.map((plugin) => plugin.name),
        unavailable: group.unavailable.map((plugin) => plugin.name),
        skillCount: group.skillCount,
      })),
    ).toEqual([
      { label: "Claude", available: ["ponytail"], unavailable: [], skillCount: 5 },
      {
        label: "Codex",
        available: ["github", "vercel"],
        unavailable: ["empty", "figma"],
        skillCount: 5,
      },
    ]);
  });
});
