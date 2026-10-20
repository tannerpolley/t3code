import { describe, expect, it } from "vite-plus/test";
import { FORK_SETTINGS_PAGES } from "./ForkSettingsPages";
import { getSettingsSearchTargetScope, searchSettings } from "./settingsSearch";

describe("fork settings destinations", () => {
  it.each([
    ["organize by folder", "organize-by-folder", "/settings/general"],
    ["default project icon", "project-icon-fallback", "/settings/appearance"],
    ["hidden local servers", "local-server-hide-rules", "/settings/integrations"],
    ["issues page", "issues-page", "/settings/source-control"],
    ["model roles", "model-roles", "/settings/providers"],
    ["role display", "sidebar-role-display", "/settings/appearance"],
    ["location icon style", "sidebar-location-icon-style", "/settings/appearance"],
    ["family style", "sidebar-family-style", "/settings/appearance"],
    ["line color", "sidebar-line-color", "/settings/appearance"],
    ["section names text size", "sidebar-section-text-size", "/settings/appearance"],
    ["project names text size", "sidebar-project-text-size", "/settings/appearance"],
    ["thread rows text size", "sidebar-thread-text-size", "/settings/appearance"],
    ["agent rows text size", "sidebar-agent-text-size", "/settings/appearance"],
    ["process rows text size", "sidebar-process-text-size", "/settings/appearance"],
    ["don't ask mode", "dont-ask-mode", "/settings/general"],
    ["inside project local .worktrees", "storage-worktrees-location", "/settings/storage"],
  ])("finds %s on its settings page", (query, id, to) => {
    expect(searchSettings(query)).toContainEqual(expect.objectContaining({ id, to }));
  });
  it("gathers fork settings in normal tab order", () => {
    expect(FORK_SETTINGS_PAGES).toEqual([
      "/settings/general",
      "/settings/appearance",
      "/settings/providers",
      "/settings/integrations",
      "/settings/source-control",
      "/settings/storage",
    ]);
    expect(getSettingsSearchTargetScope("model-roles")).toMatchObject({
      scope: "environment-defaults",
    });
  });
  it.each(["branch-picker-groups", "version-control-issues", "issues-page"])(
    "keeps %s client-scoped after moving it to Source Control",
    (id) => {
      expect(getSettingsSearchTargetScope(id)).toMatchObject({ scope: null });
    },
  );
});
