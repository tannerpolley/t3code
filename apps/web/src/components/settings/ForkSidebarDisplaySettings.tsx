import { useClientSettings, updateClientSettings as updateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DISPLAY_ROWS = [
  { key: "sidebarShowLocation", searchId: "sidebar-show-location" },
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
      <ForkSettingsRow
        {...searchableSetting("sidebar-role-display")}
        description="Show the role as a name or save title space with an explained icon."
        control={
          <Select
            value={settings.sidebarRoleDisplay}
            onValueChange={(value) => {
              if (value === "name" || value === "icon")
                updateSettings({ sidebarRoleDisplay: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Role display">
              <SelectValue>
                {settings.sidebarRoleDisplay === "icon" ? "Icons" : "Names"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="name">Names</SelectItem>
              <SelectItem value="icon">Icons</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
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
      <ForkSettingsRow
        {...searchableSetting("sidebar-line-color")}
        description="Color of the solid family lines and dashed checkout lines; reset to follow the theme."
        control={
          <span className="flex items-center gap-2">
            {settings.sidebarLineColor === null ? null : (
              <Button
                size="compact"
                variant="ghost"
                onClick={() => updateSettings({ sidebarLineColor: null })}
              >
                Reset
              </Button>
            )}
            <input
              type="color"
              aria-label="Line color"
              value={settings.sidebarLineColor ?? "#8a8a8a"}
              onChange={(event) => updateSettings({ sidebarLineColor: event.target.value })}
              className="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            />
          </span>
        }
      />
    </SettingsSection>
  );
}
