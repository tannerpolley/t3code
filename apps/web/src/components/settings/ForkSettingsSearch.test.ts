import { describe, expect, it } from "vite-plus/test";
import { getSettingsSearchTargetScope, searchSettings } from "./settingsSearch";

describe("fork settings destinations", () => {
  it.each([
    ["organize by folder", "organize-by-folder", "/settings/general"],
    ["default project icon", "project-icon-fallback", "/settings/appearance"],
    ["hidden local servers", "local-server-hide-rules", "/settings/integrations"],
    ["issues page", "issues-page", "/settings/source-control"],
    ["model roles", "model-roles", "/settings/customizations"],
    ["inside project local .worktrees", "storage-worktrees-location", "/settings/storage"],
  ])("finds %s on its settings page", (query, id, to) => {
    expect(searchSettings(query)).toContainEqual(expect.objectContaining({ id, to }));
  });
  it.each(["branch-picker-groups", "version-control-issues", "issues-page"])(
    "keeps %s client-scoped after moving it to Source Control",
    (id) => {
      expect(getSettingsSearchTargetScope(id)).toMatchObject({ scope: null });
    },
  );
});
