import type { ClientSettings } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { ModelRolesSection } from "./ModelRolesSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type CustomizationSwitchKey = {
  [Key in keyof ClientSettings]: ClientSettings[Key] extends boolean ? Key : never;
}[keyof ClientSettings];

type CustomizationSection =
  | "sidebar"
  | "lineage"
  | "composer"
  | "versionControl"
  | "browser"
  | "usage";

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
    key: "onboardingCodexSettings",
    searchId: "onboarding-codex-settings",
    section: "sidebar",
    description:
      "When onboarding imports projects you used with Codex, preview their Codex trust level and offer to apply it as the project's runtime mode.",
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
    key: "dailyUsageMeter",
    searchId: "daily-usage-meter",
    section: "usage",
    description:
      "A daily meter in the sidebar: each Monday–Friday gets 20% of each provider's weekly limit, and unused room carries forward.",
  },
  {
    key: "sidebarWeeklyUsage",
    searchId: "sidebar-weekly-usage",
    section: "usage",
    description:
      "The sidebar's Usage button shows Claude's and Codex's weekly quota left (7d 75%) instead of the chart icon, green from 70%, amber from 30%, red below. Click opens Limits.",
  },
];

function CustomizationsGroup({
  title,
  section,
  children,
}: {
  readonly title: string;
  readonly section: CustomizationSection;
  readonly children?: ReactNode;
}) {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsSection title={title}>
      {CUSTOMIZATION_SWITCHES.filter((entry) => entry.section === section).map(
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
      )}
      {children}
    </SettingsSection>
  );
}

/** A server setting: it applies to the environment running T3, not this client. */
function KeepThreadTitlesCurrentRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["keepThreadTitlesCurrent"]}
      {...searchableSetting("keep-thread-titles-current")}
      description="Every ~10 minutes, GPT-6 Luna retitles top-level threads with new activity to what they're working on now. Titles you typed are kept. Regenerate title uses the same model and says when the title still fits."
      control={
        <ScopedSwitch
          settingKeys={["keepThreadTitlesCurrent"]}
          checked={settings.keepThreadTitlesCurrent}
          onCheckedChange={(checked) =>
            updateSettings({ keepThreadTitlesCurrent: Boolean(checked) })
          }
          aria-label="Keep thread titles current"
        />
      }
    />
  );
}

/**
 * Read-only: each enabled provider's plugins, as its latest snapshot reports them. Hidden until a
 * provider reports a plugin list at all, so an older server is not mistaken for "no plugins".
 */
function ProviderPluginsSection() {
  const { environment } = useSettingsScope();
  const providers = (environment?.serverConfig?.providers ?? []).filter(
    (provider) => provider.enabled && provider.plugins !== undefined,
  );
  if (providers.length === 0) return null;
  const rows = providers.flatMap((provider) =>
    (provider.plugins ?? []).map((plugin) => ({
      provider: provider.displayName ?? provider.driver,
      plugin,
    })),
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

export function CustomizationsSettings() {
  return (
    <SettingsPageContainer>
      <CustomizationsGroup title="Sidebar & projects" section="sidebar">
        <KeepThreadTitlesCurrentRow />
      </CustomizationsGroup>
      <CustomizationsGroup title="Lineage & background work" section="lineage" />
      <CustomizationsGroup title="Composer & chat" section="composer" />
      <CustomizationsGroup title="Version control & issues" section="versionControl" />
      <CustomizationsGroup title="Browser & preview" section="browser" />
      <ModelRolesSection />
      <CustomizationsGroup title="Usage" section="usage" />
      <ProviderPluginsSection />
    </SettingsPageContainer>
  );
}
