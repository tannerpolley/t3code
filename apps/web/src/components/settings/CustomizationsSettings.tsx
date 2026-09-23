import type { ClientSettings } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

type CustomizationSwitchKey = {
  [Key in keyof ClientSettings]: ClientSettings[Key] extends boolean ? Key : never;
}[keyof ClientSettings];

/** Each switch turns one area of this fork's UI back to the original behavior when off. */
const CUSTOMIZATION_SWITCHES: ReadonlyArray<{
  readonly key: CustomizationSwitchKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: string;
}> = [
  {
    key: "projectsView",
    searchId: "projects-view",
    description:
      "Offer a Projects view of sections and projects, switched with the Activity button beside search. Off shows only the standard Activity list.",
  },
  {
    key: "codexStyleSidebar",
    searchId: "codex-style-sidebar",
    description:
      "Projects view like the Codex app: hover chevrons, rows that toggle and drag, and a spinner on running threads. Off restores chevrons, grip handles, status dots and the All projects row.",
  },
  {
    key: "sectionFolderColors",
    searchId: "section-folder-colors",
    description:
      "Tint the folder icons of a section's projects with the color chosen in the section's menu. Off keeps the colors saved but unused.",
  },
  {
    key: "versionControlIssues",
    searchId: "version-control-issues",
    description:
      "List the repository's open issues under Version Control in thread details, and open them beside the thread.",
  },
  {
    key: "branchPickerGroups",
    searchId: "branch-picker-groups",
    description:
      "Group the branch picker into collapsible Current, Local and Remote sections. Off shows one flat list.",
  },
  {
    key: "topBackButton",
    searchId: "top-back-button",
    description:
      "On Settings, Pull Requests, Issues and Usage, show Back at the top-left of the sidebar. Off puts it back at the bottom.",
  },
];

const PROJECT_ICON_FALLBACK_LABELS = { folder: "Folder", initials: "Initials" } as const;
const SIDEBAR_TOGGLE_POSITION_LABELS = { left: "Left", right: "Right" } as const;

export function CustomizationsSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection id="customizations" title="Customizations">
        {CUSTOMIZATION_SWITCHES.map(({ key, searchId, description }) => (
          <SettingsRow
            key={key}
            {...searchableSetting(searchId)}
            description={description}
            control={
              <Switch
                aria-label={searchableSetting(searchId).title}
                checked={settings[key]}
                onCheckedChange={(checked) => updateSettings({ [key]: checked })}
              />
            }
          />
        ))}
        <SettingsRow
          {...searchableSetting("sidebar-toggle-position")}
          description="Which top corner of the open sidebar holds its toggle. A collapsed sidebar keeps it at the left."
          control={
            <Select
              value={settings.sidebarTogglePosition}
              onValueChange={(value) => {
                if (value === "left" || value === "right") {
                  updateSettings({ sidebarTogglePosition: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Toggle button position"
              >
                <SelectValue>
                  {SIDEBAR_TOGGLE_POSITION_LABELS[settings.sidebarTogglePosition]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="left">
                  {SIDEBAR_TOGGLE_POSITION_LABELS.left}
                </SelectItem>
                <SelectItem hideIndicator value="right">
                  {SIDEBAR_TOGGLE_POSITION_LABELS.right}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("project-icon-fallback")}
          description="Shown for projects without a favicon or custom icon."
          control={
            <Select
              value={settings.projectIconFallback}
              onValueChange={(value) => {
                if (value === "folder" || value === "initials") {
                  updateSettings({ projectIconFallback: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Default project icon">
                <SelectValue>
                  {PROJECT_ICON_FALLBACK_LABELS[settings.projectIconFallback]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="folder">
                  {PROJECT_ICON_FALLBACK_LABELS.folder}
                </SelectItem>
                <SelectItem hideIndicator value="initials">
                  {PROJECT_ICON_FALLBACK_LABELS.initials}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
