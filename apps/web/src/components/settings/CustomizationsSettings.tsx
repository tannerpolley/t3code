import type { ClientSettings } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

type CustomizationSwitchKey = {
  [Key in keyof ClientSettings]: ClientSettings[Key] extends boolean ? Key : never;
}[keyof ClientSettings];

type CustomizationSection = "composer" | "versionControl" | "usage";

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
}: {
  readonly title: string;
  readonly section: CustomizationSection;
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
    </SettingsSection>
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
      <CustomizationsGroup title="Composer & chat" section="composer" />
      <CustomizationsGroup title="Version control & issues" section="versionControl" />
      {/* Model roles (delegation defaults) get their own section here. */}
      <CustomizationsGroup title="Usage" section="usage" />
      <ProviderPluginsSection />
    </SettingsPageContainer>
  );
}
