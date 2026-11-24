import { T, useGT } from "gt-react";
import { useClientSettings, updateClientSettings as updateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const DISPLAY_ROWS = [
  { key: "sidebarShowLocation", searchId: "sidebar-show-location" },
  { key: "sidebarShowProvider", searchId: "sidebar-show-provider" },
  { key: "sidebarShowModel", searchId: "sidebar-show-model" },
  { key: "sidebarShowModelVersion", searchId: "sidebar-show-model-version" },
  { key: "sidebarShowEffort", searchId: "sidebar-show-effort" },
  { key: "sidebarShowIssueBadge", searchId: "sidebar-show-issue-badge" },
  { key: "sidebarShowPullRequestBadge", searchId: "sidebar-show-pull-request-badge" },
] as const;

export function ForkSidebarDisplaySettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings();
  return (
    <SettingsSection title={gt("Sidebar & projects")}>
      <ForkSettingsRow
        {...searchableSetting("sidebar-role-display")}
        description={gt("Show the role as a name or save title space with an explained icon.")}
        control={
          <Select
            value={settings.sidebarRoleDisplay}
            onValueChange={(value) => {
              if (value === "name" || value === "icon")
                updateSettings({ sidebarRoleDisplay: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Role display")}>
              <SelectValue>
                {settings.sidebarRoleDisplay === "icon" ? gt("Icons") : gt("Names")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="name">
                <T>Names</T>
              </SelectItem>
              <SelectItem value="icon">
                <T>Icons</T>
              </SelectItem>
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
            description={gt(
              "Show in Codex-style Projects rows. Hidden columns leave more room for the title.",
            )}
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
        description={gt("Choose the worktree mark; the main checkout keeps its folder icon.")}
        control={
          <Select
            value={settings.sidebarLocationIconStyle}
            onValueChange={(value) => {
              if (value === "worktree" || value === "branch")
                updateSettings({ sidebarLocationIconStyle: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Location icon style")}>
              <SelectValue>
                {settings.sidebarLocationIconStyle === "branch" ? gt("Branch") : gt("Worktree")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="worktree">
                <T>Worktree</T>
              </SelectItem>
              <SelectItem value="branch">
                <T>Branch</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <ForkSettingsRow
        {...searchableSetting("sidebar-family-style")}
        description={gt(
          "Connect related threads with color tints or subtle solid family lines and dashed worker lines.",
        )}
        control={
          <Select
            value={settings.sidebarFamilyStyle}
            onValueChange={(value) => {
              if (value === "colors" || value === "lines")
                updateSettings({ sidebarFamilyStyle: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Family style")}>
              <SelectValue>
                {settings.sidebarFamilyStyle === "lines" ? gt("Lines") : gt("Colors")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="colors">
                <T>Colors</T>
              </SelectItem>
              <SelectItem value="lines">
                <T>Lines</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <ForkSettingsRow
        {...searchableSetting("sidebar-line-color")}
        description={gt(
          "Color of the solid family lines and dashed checkout lines; reset to follow the theme.",
        )}
        control={
          <span className="flex items-center gap-2">
            {settings.sidebarLineColor === null ? null : (
              <Button
                size="compact"
                variant="ghost"
                onClick={() => updateSettings({ sidebarLineColor: null })}
              >
                <T>Reset</T>
              </Button>
            )}
            <input
              type="color"
              aria-label={gt("Line color")}
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
