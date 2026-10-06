import type { ClientSettings, ServerProviderPlugin } from "@t3tools/contracts";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  addLocalServerHideRule,
  describeLocalServerHideRule,
  parseLocalServerHideRule,
} from "../preview/localServerHideRules";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { groupProviderPlugins } from "./CustomizationsSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ModelRolesSection } from "./ModelRolesSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SidebarProjectSettings } from "./SidebarProjectSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type CustomizationSwitchKey = {
  [Key in keyof ClientSettings]: ClientSettings[Key] extends boolean ? Key : never;
}[keyof ClientSettings];

// "folders" holds the automatic organization switch, rendered beside its root folder.
type CustomizationSection =
  | "sidebar"
  | "folders"
  | "lineage"
  | "composer"
  | "versionControl"
  | "browser"
  | "usage"
  | "motion";

/**
 * Each switch turns one area of this fork's UI back to the original behavior when off, so with
 * every switch off the app is vanilla. A ported fork feature adds its row here.
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
      "Projects view like the Codex app: hover chevrons, rows that toggle and drag, a blue spinner on running threads, smaller thread titles, running subagents and their own subagents and shells in a tree under their thread with model and title, each level collapsible, how long each working or waiting thread, subagent and background process has been running, and New thread in the project menu instead of a hover button. Off restores chevrons, grip handles, status dots and the All projects row.",
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
    section: "folders",
    description:
      "Put projects that are in no section yet into their folder's section automatically, using the Organize by folder root. Projects you move by hand stay where you put them.",
  },
  {
    key: "revealOpenThreadInSidebar",
    searchId: "reveal-open-thread-in-sidebar",
    section: "sidebar",
    description:
      "When you open a thread by any route (a link, Lineage, search, a notification, a shortcut, Back or Forward), open the sections and project that hold it and scroll its row into view. A subagent reveals its parent's row. It runs when you open a thread, so a project you collapse afterwards stays collapsed.",
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
      "Lineage rows lead with model and effort, end in a status mark (spinner, green done dot, failure icon) and open into details; Clear hides finished agents under Previous agents. Off restores the original Lineage rows.",
  },
  {
    key: "lineageDetailsExpanded",
    searchId: "lineage-details-expanded",
    section: "lineage",
    description:
      "Open every Lineage row's details (model, effort, status, branch, latest progress) by default. Rows you close by hand stay closed. Needs the redesigned Lineage.",
  },
  {
    key: "backgroundProcessOutput",
    searchId: "background-process-output",
    section: "lineage",
    description:
      "Click a Codex or Claude background command or monitor in Projects, Lineage, or the chat task list to follow its output in a terminal tab. On Windows, or if a terminal cannot follow it, view the live output in a popover. Commands also show their kind, age, available CPU and memory use, and a Stop control.",
  },
  {
    key: "shortModelNames",
    searchId: "short-model-names",
    section: "lineage",
    description:
      "Model labels drop the company name the provider icon already shows and lead with the model's own name, then its version: Opus 5.5, Sonnet 5, Sol 6. Applies to the sidebar, Lineage, agent details and the composer's model button, always right after the icon; the model list keeps full names. Off restores the full names.",
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
    key: "openQuestionsAutomatically",
    searchId: "open-questions-automatically",
    section: "composer",
    description:
      "When an agent in any thread, including another project's or a subagent's, asks you a question, show it in a floating panel over whatever you are viewing, so you can answer on the spot. Later hides a question until it is asked again; the thread still shows it. Off shows questions only in their thread.",
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
      "List the repository's open issues in their own Issues section of thread details, grouped by collapsible milestones, and open them beside the thread.",
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
    key: "usageLimitModelBreakdown",
    searchId: "usage-limit-model-breakdown",
    section: "usage",
    description:
      "Lay out the Usage page's Limits view like Cost and Tokens: pick a window (5 hours, weekly, monthly), see what is left per provider, and chart its estimated use by provider or model, from the usage your connected environments recorded. Off shows the per-provider window cards.",
  },
  {
    key: "sidebarFiveHourUsage",
    searchId: "sidebar-five-hour-usage",
    section: "usage",
    description:
      "The sidebar's Usage button shows Claude's and Codex's five-hour quota left (5h 62%). Hover for when it resets.",
  },
  {
    key: "dailyUsageMeter",
    searchId: "daily-usage-meter",
    section: "usage",
    description:
      "The sidebar's Usage button shows today's budget left (1d 40%): each Monday–Friday gets 20% of each provider's weekly limit, and unused room carries forward. Red when over pace.",
  },
  {
    key: "sidebarWeeklyUsage",
    searchId: "sidebar-weekly-usage",
    section: "usage",
    description:
      "The sidebar's Usage button shows Claude's and Codex's weekly quota left (7d 75%). With any usage readout on, the button replaces its chart icon, colors each value green from 70%, amber from 30%, red below, and opens Limits.",
  },
  {
    key: "fastShimmer",
    searchId: "fast-shimmer",
    section: "motion",
    description:
      "Run the shimmer over running activity faster and smoother: 1.4 seconds per pass instead of 2.2.",
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

function CustomizationsGroup({
  title,
  section,
  children,
}: {
  readonly title: string;
  readonly section: CustomizationSection;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection title={title}>
      <CustomizationSwitchRows section={section} />
      {children}
    </SettingsSection>
  );
}

type ServerSwitchKey = "keepThreadTitlesCurrent" | "agentBrowserTabLimits";

/** A server setting: it applies to the environment running T3, not this client. */
function ServerSwitchRow({
  settingKey,
  searchId,
  description,
}: {
  readonly settingKey: ServerSwitchKey;
  readonly searchId: SettingsSearchItemId;
  readonly description: string;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={[settingKey]}
      {...searchableSetting(searchId)}
      description={description}
      control={
        <ScopedSwitch
          settingKeys={[settingKey]}
          checked={settings[settingKey]}
          onCheckedChange={(checked) => updateSettings({ [settingKey]: Boolean(checked) })}
          aria-label={searchableSetting(searchId).title}
        />
      }
    />
  );
}

const pluginDescription = (plugin: ServerProviderPlugin) =>
  [
    plugin.marketplace,
    `${plugin.skillCount} ${plugin.skillCount === 1 ? "skill" : "skills"}`,
    plugin.requiresDesktopApp ? "Needs the ChatGPT desktop app" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

const pluginRows = (plugins: ReadonlyArray<ServerProviderPlugin>) =>
  plugins.map((plugin) => (
    <SettingsRow
      key={`${plugin.name}@${plugin.marketplace ?? ""}`}
      title={plugin.name}
      description={pluginDescription(plugin)}
    />
  ));

/** Plugins that offer no skills here, folded away under their provider's usable ones. */
function UnavailablePlugins({
  plugins,
}: {
  readonly plugins: ReadonlyArray<ServerProviderPlugin>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Unavailable / no skills · {plugins.length}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
          {pluginRows(plugins)}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Read-only: each enabled provider's plugins, as its latest snapshot reports them. */
function ProviderPluginsSection() {
  const { environment } = useSettingsScope();
  const groups = groupProviderPlugins(environment?.serverConfig?.providers ?? []);
  if (groups === null) return null;
  if (groups.length === 0) {
    return (
      <SettingsSection title="Plugins">
        <SettingsRow
          title="No enabled plugins"
          description="Plugins you enable in Claude Code or Codex are listed here, with their skills offered under $."
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Plugins" variant="plain">
      {groups.map((group) => (
        <FoldedSettingsSection
          key={group.key}
          id={`plugins-${group.key}`}
          title={group.label}
          summary={[
            `${group.available.length} ${group.available.length === 1 ? "plugin" : "plugins"}`,
            `${group.skillCount} ${group.skillCount === 1 ? "skill" : "skills"}`,
            group.unavailable.length > 0 ? `${group.unavailable.length} unavailable` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {pluginRows(group.available)}
          {group.unavailable.length > 0 ? <UnavailablePlugins plugins={group.unavailable} /> : null}
        </FoldedSettingsSection>
      ))}
    </SettingsSection>
  );
}

const PROJECT_ICON_FALLBACK_LABELS = { folder: "Folder", initials: "Initials" } as const;
const SIDEBAR_TOGGLE_POSITION_LABELS = { left: "Left", right: "Right" } as const;
const LINEAGE_AUTO_CLEAR_MINUTES = [0, 30, 60] as const;
const lineageAutoClearLabel = (minutes: number) =>
  minutes === 0 ? "Off" : minutes === 60 ? "1 hour" : `${minutes} minutes`;

function LocalServerHideRulesRow() {
  const rules = useClientSettings((settings) => settings.browserLocalServerHideRules);
  const updateSettings = useUpdateClientSettings();
  const [draft, setDraft] = useState("");
  const parsed = parseLocalServerHideRule(draft);
  const add = () => {
    if (!parsed) return;
    void updateSettings({ browserLocalServerHideRules: addLocalServerHideRule(rules, parsed) });
    setDraft("");
  };
  return (
    <SettingsRow
      {...searchableSetting("local-server-hide-rules")}
      description="Servers the browser's Local servers list leaves out. Hide one from its menu in the list, or add a process name (serena) or a port range (24282-24304) here. Remove a rule to bring its servers back."
    >
      <div className="flex max-w-2xl flex-col gap-2 pb-3.5">
        {rules.map((rule) => {
          const label = describeLocalServerHideRule(rule);
          return (
            <div key={label} className="flex items-center justify-between gap-2 text-sm">
              <span>{label}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Show ${label} again`}
                onClick={() =>
                  void updateSettings({
                    browserLocalServerHideRules: rules.filter((existing) => existing !== rule),
                  })
                }
              >
                <XIcon />
              </Button>
            </div>
          );
        })}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input
            aria-label="Process name or port range to hide"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="serena or 24282-24304"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!parsed}>
            Hide
          </Button>
        </form>
      </div>
    </SettingsRow>
  );
}

export function CustomizationsSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsPageContainer>
      <CustomizationsGroup title="Sidebar & projects" section="sidebar">
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
        <CustomizationSwitchRows section="folders" />
        <SidebarProjectSettings />
        <ServerSwitchRow
          settingKey="keepThreadTitlesCurrent"
          searchId="keep-thread-titles-current"
          description="Every ~10 minutes, GPT-6 Luna retitles top-level threads with new activity to what they're working on now. Titles you typed are kept. Regenerate title uses the same model and says when the title still fits."
        />
      </CustomizationsGroup>
      <CustomizationsGroup title="Lineage & background work" section="lineage">
        <SettingsRow
          {...searchableSetting("lineage-auto-clear")}
          description="Hide finished agents from Lineage's Previous agents once they have sat unused this long, as if you pressed Clear. An agent you resume shows again. Show brings cleared ones back. Needs the Lineage redesign."
          control={
            <Select
              value={String(settings.lineageAutoClearMinutes)}
              onValueChange={(value) => updateSettings({ lineageAutoClearMinutes: Number(value) })}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Clear finished agents after"
              >
                <SelectValue>{lineageAutoClearLabel(settings.lineageAutoClearMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {LINEAGE_AUTO_CLEAR_MINUTES.map((minutes) => (
                  <SelectItem hideIndicator key={minutes} value={String(minutes)}>
                    {lineageAutoClearLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </CustomizationsGroup>
      <CustomizationsGroup title="Composer & chat" section="composer" />
      <CustomizationsGroup title="Version control & issues" section="versionControl" />
      <CustomizationsGroup title="Browser & preview" section="browser">
        <ServerSwitchRow
          settingKey="agentBrowserTabLimits"
          searchId="agent-browser-tab-limits"
          description="A thread keeps at most 3 browser tabs an agent opened; opening another closes the oldest. A tab stuck loading gets one hard reload and a retry. Off leaves agent tabs unlimited and returns the timeout."
        />
        <LocalServerHideRulesRow />
      </CustomizationsGroup>
      <ModelRolesSection />
      <CustomizationsGroup title="Usage" section="usage" />
      <CustomizationsGroup title="Appearance & motion" section="motion" />
      <ProviderPluginsSection />
    </SettingsPageContainer>
  );
}
