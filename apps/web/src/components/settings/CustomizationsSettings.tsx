import type { ClientSettings, ServerSettings } from "@t3tools/contracts";
import type { ReactNode } from "react";
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

type CustomizationSection =
  | "sidebar"
  | "lineage"
  | "composer"
  | "versionControl"
  | "browser"
  | "motion";

/**
 * Each switch turns one area of this fork's UI back to the original behavior when off, so with
 * every switch off (and the environment rows below at their original values) the app is vanilla.
 */
const CUSTOMIZATION_SWITCHES: ReadonlyArray<{
  readonly key: CustomizationSwitchKey;
  readonly searchId: SettingsSearchItemId;
  readonly section: CustomizationSection;
  readonly description: string;
}> = [
  {
    key: "projectsView",
    searchId: "projects-view",
    section: "sidebar",
    description:
      "Offer a Projects view of sections and projects, turned on and off with the folder button beside search (blue while on). Off shows only the standard Activity list.",
  },
  {
    key: "codexStyleSidebar",
    searchId: "codex-style-sidebar",
    section: "sidebar",
    description:
      "Projects view like the Codex app: hover chevrons, rows that toggle and drag, and a spinner on running threads. Off restores chevrons, grip handles, status dots and the All projects row.",
  },
  {
    key: "sectionFolderColors",
    searchId: "section-folder-colors",
    section: "sidebar",
    description:
      "Tint the folder icons of a section's projects with the color chosen in the section's menu. Off keeps the colors saved but unused.",
  },
  {
    key: "autoOrganizeByFolder",
    searchId: "auto-organize-by-folder",
    section: "sidebar",
    description:
      "Put projects that are in no section yet into their folder's section automatically, using the Organize by folder root. Projects you move by hand stay where you put them.",
  },
  {
    key: "activityNeedsYouFirst",
    searchId: "activity-needs-you-first",
    section: "sidebar",
    description:
      "In the Activity list, threads waiting on you (a question, an approval, a failure or a usage limit) sit at the top until you deal with them. Off keeps the standard order: newest first, then threads you arranged by dragging.",
  },
  {
    key: "topBackButton",
    searchId: "top-back-button",
    section: "sidebar",
    description:
      "Shows a Back button at the top-left of the Settings, Pull Requests, Issues and Usage pages, in addition to the one at the bottom of the sidebar.",
  },
  {
    key: "onboardingCodexSettings",
    searchId: "onboarding-codex-settings",
    section: "sidebar",
    description:
      "When onboarding imports projects you used with Codex, preview their Codex trust level and offer to apply it as the project's runtime mode.",
  },
  {
    key: "threadDetailsRedesign",
    searchId: "thread-details-redesign",
    section: "lineage",
    description:
      "Lineage rows lead with model and effort, end in a status mark (spinner, green done dot, failure icon) and open into details; a Background processes block lists running shells; the bar above the composer shrinks to one Stop line; thread-details labels are larger. Off restores the original Lineage rows, the task list in the bar and the smaller labels.",
  },
  {
    key: "lineageDetailsExpanded",
    searchId: "lineage-details-expanded",
    section: "lineage",
    description:
      "Open every Lineage row's details (model, effort, status, branch, latest progress) by default. Rows you close by hand stay closed. Needs the redesigned Lineage.",
  },
  {
    key: "composerCodeFormatting",
    searchId: "composer-code-formatting",
    section: "composer",
    description:
      "With rich text on, typing ``` or ```python and pressing Enter starts a code block in the composer, sent as a normal Markdown fence. Enter adds lines; press Enter on two blank last lines, or ArrowDown at the end, to leave it. Off keeps fences as plain text.",
  },
  {
    key: "chatMath",
    searchId: "chat-math",
    section: "composer",
    description:
      "Render math in chat messages: $…$, $$…$$, \\( \\) and \\[ \\]. Dollar amounts such as $5 stay text. Off shows the formula source as plain text.",
  },
  {
    key: "pluginSkills",
    searchId: "plugin-skills",
    section: "composer",
    description:
      "Offer the skills of your enabled Claude Code plugins (plugin:skill) in the composer's $ and / menus, and label plugin skills Plugin. Off hides Claude plugin skills and labels Codex plugin skills App.",
  },
  {
    key: "versionControlIssues",
    searchId: "version-control-issues",
    section: "versionControl",
    description:
      "List the repository's open issues under Version Control in thread details, and open them beside the thread.",
  },
  {
    key: "issuesPage",
    searchId: "issues-page",
    section: "versionControl",
    description:
      "Show Issues in the sidebar: browse open issues across the repositories you control, grouped by owner, filtered, with pinned repositories.",
  },
  {
    key: "branchPickerGroups",
    searchId: "branch-picker-groups",
    section: "versionControl",
    description:
      "Group the branch picker into collapsible Current, Local and Remote sections. Off shows one flat list.",
  },
  {
    key: "agentBrowserInPanel",
    searchId: "agent-browser-in-panel",
    section: "browser",
    description:
      "When an agent uses the in-app browser, show it in the right side panel instead of the small floating player.",
  },
  {
    key: "fastShimmer",
    searchId: "fast-shimmer",
    section: "motion",
    description:
      "Run the shimmer over running activity faster and smoother: 1.4 seconds per pass instead of 2.2.",
  },
];

/** Fixes of the original app's behavior. They have no switch: turning one off would bring the bug back. */
const ALWAYS_ON_FIXES: ReadonlyArray<{ readonly title: string; readonly description: string }> = [
  {
    title: "Interrupted threads resume after a restart",
    description: "Threads that were working before a crash or update pick up where they left off.",
  },
  {
    title: "Steered subagents show as running",
    description: "A subagent you send new work to shows as running in Lineage, not finished.",
  },
  {
    title: "Failed turns show as failed",
    description: "A turn that failed shows as failed even while background work is still running.",
  },
  {
    title: "Slow pages keep the agent's browser connected",
    description: "A page that never finishes loading no longer disconnects the agent's browser.",
  },
  {
    title: "Disconnected Codex sessions stop their MCP servers",
    description: "Disconnecting a Codex session unloads it, so the MCP servers it started stop.",
  },
];

function CustomizationSwitchRows({ section }: { readonly section: CustomizationSection }) {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  return CUSTOMIZATION_SWITCHES.filter((entry) => entry.section === section).map(
    ({ key, searchId, description }) => (
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
    ),
  );
}

type ServerSwitchKey = {
  [Key in keyof ServerSettings]: ServerSettings[Key] extends boolean ? Key : never;
}[keyof ServerSettings];

/** A switch for a setting of the environment running T3, enforced by its server. */
function ServerSwitchRow(props: {
  readonly settingKey: ServerSwitchKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: string;
}) {
  const scopedSettings = useScopedSettings();
  const updateScopedSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed([props.settingKey]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={[props.settingKey]}
      {...searchableSetting(props.searchId)}
      description={props.description}
      control={
        <Switch
          aria-label={searchableSetting(props.searchId).title}
          mixed={mixed}
          checked={mixed ? false : scopedSettings[props.settingKey]}
          onCheckedChange={(checked) => updateScopedSettings({ [props.settingKey]: checked })}
        />
      }
    />
  );
}

function CustomizationsGroup(props: {
  readonly title: string;
  readonly section?: CustomizationSection;
  readonly id?: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...(props.id ? { id: props.id } : {})} title={props.title}>
      {props.section ? <CustomizationSwitchRows section={props.section} /> : null}
      {props.children}
    </SettingsSection>
  );
}

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
      <CustomizationsGroup id="customizations" title="Sidebar & projects" section="sidebar">
        <SettingsRow
          {...searchableSetting("sidebar-toggle-position")}
          description="Which top corner of the open sidebar holds its toggle. A collapsed sidebar keeps it at the left. Left is the original."
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
          description="Shown for projects without a favicon or custom icon. Initials is the original."
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
      </CustomizationsGroup>
      <CustomizationsGroup title="Lineage & background work" section="lineage" />
      <CustomizationsGroup title="Composer & chat" section="composer" />
      <CustomizationsGroup title="Version control & issues" section="versionControl" />
      <CustomizationsGroup title="Browser & preview" section="browser">
        <ServerSwitchRow
          settingKey="agentBrowserTabLimits"
          searchId="agent-browser-tab-limits"
          description="A thread keeps at most 3 browser tabs an agent opened; opening another closes the oldest. A tab stuck loading gets one hard reload and a retry. Off leaves agent tabs unlimited and returns the timeout."
        />
      </CustomizationsGroup>
      <CustomizationsGroup title="Agent sessions & access">
        <SettingsRow
          serverScoped
          settingKeys={["idleAgentSessionMinutes"]}
          {...searchableSetting("idle-agent-session-disconnect")}
          description="Stop a thread's agent session, and the MCP servers it started, after it sits idle this long. The next message reconnects it. Working threads, pending approvals, and running subagents are never touched. Off is the original."
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
        <ServerSwitchRow
          settingKey="topLevelThreadsReadAllProjects"
          searchId="top-level-threads-read-all-projects"
          description="Let agents in top-level threads read, but not change, threads in other projects on this environment. Subagents and delegated tasks stay limited to their own project."
        />
      </CustomizationsGroup>
      <CustomizationsGroup title="Appearance & motion" section="motion" />
      <SettingsSection title="Always-on fixes">
        {ALWAYS_ON_FIXES.map((fix) => (
          <SettingsRow key={fix.title} title={fix.title} description={fix.description} />
        ))}
      </SettingsSection>
      <ProviderPluginsSection />
    </SettingsPageContainer>
  );
}
