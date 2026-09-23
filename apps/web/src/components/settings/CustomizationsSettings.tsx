import type { ClientSettings } from "@t3tools/contracts";
import { buildProjectGroups, selectProjectGroupingSettings } from "../../logicalProject";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { toastManager } from "../ui/toast";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

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
    key: "autoOrganizeByFolder",
    searchId: "auto-organize-by-folder",
    description:
      "Put projects that are in no section yet into their folder's section automatically, using the Organize by folder root. Projects you move by hand stay where you put them.",
  },
  {
    key: "lineageDetailsExpanded",
    searchId: "lineage-details-expanded",
    description:
      "Open every Lineage row's details (model, effort, status, branch, latest progress) by default. Rows you close by hand stay closed.",
  },
  {
    key: "topBackButton",
    searchId: "top-back-button",
    description:
      "On Settings, Pull Requests, Issues and Usage, show Back at the top-left of the sidebar. Off puts it back at the bottom.",
  },
];

/** Read-only: each provider's enabled plugins, as its latest snapshot reports them. */
function ProviderPluginsSection() {
  const { environment } = useSettingsScope();
  const rows = (environment?.serverConfig?.providers ?? []).flatMap((provider) =>
    provider.enabled
      ? (provider.plugins ?? []).map((plugin) => ({
          provider: provider.displayName ?? provider.driver,
          plugin,
        }))
      : [],
  );
  return (
    <SettingsSection title="Plugins">
      {rows.length === 0 ? (
        <SettingsRow
          title="No enabled plugins"
          description="Plugins you enable in Claude Code or Codex are listed here, with their skills offered under $."
        />
      ) : (
        rows.map(({ provider, plugin }) => (
          <SettingsRow
            key={`${provider}:${plugin.name}@${plugin.marketplace ?? ""}`}
            title={plugin.name}
            description={[
              provider,
              plugin.marketplace,
              `${plugin.skillCount} ${plugin.skillCount === 1 ? "skill" : "skills"}`,
              plugin.requiresDesktopApp ? "Needs the ChatGPT desktop app" : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ))
      )}
    </SettingsSection>
  );
}

const PROJECT_ICON_FALLBACK_LABELS = { folder: "Folder", initials: "Initials" } as const;
const SIDEBAR_TOGGLE_POSITION_LABELS = { left: "Left", right: "Right" } as const;
const IDLE_AGENT_SESSION_MINUTES = [0, 15, 30, 60, 120] as const;
const idleAgentSessionLabel = (minutes: number) => (minutes === 0 ? "Off" : `${minutes} minutes`);

export function CustomizationsSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const projects = useProjects();
  // Paths belong to the machine running T3, so the root is an environment setting like
  // "Add project starts in", which it falls back to when empty.
  const scopedSettings = useScopedSettings();
  const updateScopedSettings = useUpdateScopedSettings();
  const folderRootMixed = useScopedSettingsMixed(["projectFolderRoot"]);
  const idleMinutesMixed = useScopedSettingsMixed(["idleAgentSessionMinutes"]);
  const baseDirectory = scopedSettings.addProjectBaseDirectory;
  const folderRoot =
    scopedSettings.projectFolderRoot || (baseDirectory.startsWith("/") ? baseDirectory : "");
  const organize = () => {
    if (!folderRoot.startsWith("/")) {
      toastManager.add({
        type: "error",
        title: "Use a full folder path",
        description:
          "Organize by folder needs a path starting with /, such as /home/you/Workspaces.",
      });
      return;
    }
    // The sidebar's own grouping, so each checkout lands under the key the sidebar shows.
    const groups = buildProjectGroups({
      projects,
      settings: selectProjectGroupingSettings(settings),
    });
    useUiStateStore.getState().organizeSidebarSectionsByFolder(
      groups.map((group) => ({
        projectKey: group.key,
        workspaceRoots: group.members.map((member) => member.project.workspaceRoot),
      })),
      folderRoot,
    );
    toastManager.add({
      type: "success",
      title: "Sections organized",
      description: `Projects under ${folderRoot} now follow its folders.`,
    });
  };

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
          serverScoped
          settingKeys={["projectFolderRoot"]}
          {...searchableSetting("organize-by-folder")}
          description={
            'Mirror a folder\'s layout as sections: root/A/B/project goes to section A, subsection B. Projects inside another project stay with it; projects elsewhere keep their place. Safe to run again. Leave empty to use "Add project starts in" when that is a full path.'
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-96">
              <DraftInput
                aria-label="Folder to organize by"
                className="min-w-0 flex-1"
                onCommit={(next) => updateScopedSettings({ projectFolderRoot: next })}
                placeholder={
                  folderRootMixed
                    ? "Mixed"
                    : baseDirectory.startsWith("/")
                      ? baseDirectory
                      : "/home/you/Workspaces"
                }
                size="sm"
                spellCheck={false}
                value={folderRootMixed ? "" : scopedSettings.projectFolderRoot}
              />
              <Button
                disabled={folderRoot.length === 0}
                onClick={organize}
                size="sm"
                variant="outline"
              >
                Organize
              </Button>
            </div>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["idleAgentSessionMinutes"]}
          {...searchableSetting("idle-agent-session-disconnect")}
          description="Stop a thread's agent session, and the MCP servers it started, after it sits idle this long. The next message reconnects it. Working threads, pending approvals, and running subagents are never touched."
          control={
            <Select
              value={String(scopedSettings.idleAgentSessionMinutes)}
              onValueChange={(value) =>
                updateScopedSettings({ idleAgentSessionMinutes: Number(value) })
              }
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Disconnect idle agent sessions after"
              >
                <SelectValue>
                  {idleMinutesMixed
                    ? "Mixed"
                    : idleAgentSessionLabel(scopedSettings.idleAgentSessionMinutes)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {IDLE_AGENT_SESSION_MINUTES.map((minutes) => (
                  <SelectItem hideIndicator key={minutes} value={String(minutes)}>
                    {idleAgentSessionLabel(minutes)}
                  </SelectItem>
                ))}
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
      <ProviderPluginsSection />
    </SettingsPageContainer>
  );
}
