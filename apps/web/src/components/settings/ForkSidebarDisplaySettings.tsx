import { useClientSettings, updateClientSettings as updateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DISPLAY_ROWS = [
  { key: "sidebarShowLocation", searchId: "sidebar-show-location" },
  { key: "sidebarShowRole", searchId: "sidebar-show-role" },
  { key: "sidebarShowProvider", searchId: "sidebar-show-provider" },
  { key: "sidebarShowModel", searchId: "sidebar-show-model" },
  { key: "sidebarShowEffort", searchId: "sidebar-show-effort" },
  { key: "sidebarShowIssueBadge", searchId: "sidebar-show-issue-badge" },
  { key: "sidebarShowPullRequestBadge", searchId: "sidebar-show-pull-request-badge" },
] as const;

export function ForkSidebarDisplaySettings() {
  const settings = useClientSettings();
  if (!settings.codexStyleSidebar) return null;
  return (
    <SettingsSection title="Sidebar & projects">
      {DISPLAY_ROWS.map(({ key, searchId }) => {
        const setting = searchableSetting(searchId);
        return (
          <ForkSettingsRow
            key={key}
            {...setting}
            description="Show in Codex-style Projects rows. Hidden columns leave more room for the title."
            control={
              <Switch
                checked={settings[key]}
                aria-label={setting.title}
                onCheckedChange={(checked) => updateSettings({ [key]: Boolean(checked) })}
              />
            }
          />
        );
      })}
      <ForkSettingsRow
        {...searchableSetting("sidebar-location-icon-style")}
        description="Choose the worktree mark; the main checkout keeps its folder icon."
        control={
          <Select
            value={settings.sidebarLocationIconStyle}
            onValueChange={(value) => {
              if (value === "worktree" || value === "branch")
                updateSettings({ sidebarLocationIconStyle: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Location icon style">
              <SelectValue>
                {settings.sidebarLocationIconStyle === "branch" ? "Branch" : "Worktree"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="worktree">Worktree</SelectItem>
              <SelectItem value="branch">Branch</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <ForkSettingsRow
        {...searchableSetting("sidebar-family-style")}
        description="Connect related threads with color tints or subtle solid family lines and dashed worker lines."
        control={
          <Select
            value={settings.sidebarFamilyStyle}
            onValueChange={(value) => {
              if (value === "colors" || value === "lines")
                updateSettings({ sidebarFamilyStyle: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Family style">
              <SelectValue>
                {settings.sidebarFamilyStyle === "lines" ? "Lines" : "Colors"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="colors">Colors</SelectItem>
              <SelectItem value="lines">Lines</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
