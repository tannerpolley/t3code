import { msg } from "gt-react";
import type { SettingsSearchItem } from "./settingsSearch";

export const FORK_SETTINGS_SEARCH_ITEMS = [
  {
    id: "reset-credit-reminders",
    title: msg("Banked reset reminders"),
    to: "/settings/general",
    searchTerms: ["banked reset credits expiry expires reminders notification sound"],
  },
  {
    id: "auto-use-expiring-reset-credits",
    title: msg("Auto-use expiring banked resets"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["automatic banked reset credit expiry expires redeem use"],
  },
  {
    id: "dont-ask-mode",
    title: msg("Ask mode"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "don't ask dont ask fork automatic questions recommended answers approvals away unattended",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: msg("Worktree location"),
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: [
      msg("worktree location folder directory path drive external disk"),
      "inside project local .worktrees customizations",
    ],
  },
  {
    id: "interface-zoom",
    title: msg("Interface zoom"),
    to: "/settings/appearance",
    searchTerms: ["zoom scale size larger smaller display resolution ctrl plus minus"],
    desktopOnly: true,
  },
  {
    id: "thread-order",
    title: msg("Thread order"),
    to: "/settings/general",
    searchTerms: ["sort threads sidebar projects last user message created recent"],
  },
  {
    id: "usage-limit-recovery",
    title: msg("Usage limit recovery"),
    to: "/settings/general",
    searchTerms: [
      "auto resume snooze usage quota rate limit reset switch provider fallback model effort recover continue",
    ],
  },
  {
    id: "keep-running-in-background",
    title: msg("Keep running in background"),
    to: "/settings/general",
    searchTerms: [
      "system tray icon close window hide quit exit agents remote phone connections stay open",
    ],
    desktopOnly: true,
    hiddenOnMac: true,
  },
  {
    id: "sidebar-toggle-position",
    // A search for "toggle sidebar" means the keybinding, so this row ranks after it.
    title: msg("Toggle button position"),
    to: "/settings/appearance",
    secondary: true,
    searchTerms: ["customization fork sidebar toggle collapse left right corner"],
  },
  {
    id: "project-icon-fallback",
    title: msg("Default project icon"),
    to: "/settings/appearance",
    searchTerms: ["project icon folder initials monogram letters favicon sidebar"],
  },
  {
    id: "organize-by-folder",
    title: msg("Organize by folder"),
    to: "/settings/general",
    searchTerms: ["customization fork sections subsections folders workspaces organize mirror"],
  },
  {
    id: "projects-view",
    title: msg("Projects view"),
    to: "/settings/general",
    searchTerms: ["customization fork projects view sections activity sidebar mode"],
  },
  {
    id: "sidebar-section-text-size",
    title: msg("Section names text size"),
    to: "/settings/appearance",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller section names headers",
    ],
  },
  {
    id: "sidebar-project-text-size",
    title: msg("Project names text size"),
    to: "/settings/appearance",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller project names repository",
    ],
  },
  {
    id: "sidebar-thread-text-size",
    title: msg("Thread rows text size"),
    to: "/settings/appearance",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller thread rows titles",
    ],
  },
  {
    id: "sidebar-agent-text-size",
    title: msg("Agent rows text size"),
    to: "/settings/appearance",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller agent work rows workers tasks subagents",
    ],
  },
  {
    id: "sidebar-process-text-size",
    title: msg("Process rows text size"),
    to: "/settings/appearance",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller process rows commands shell",
    ],
  },
  {
    id: "codex-style-sidebar",
    title: msg("Codex-style project sidebar"),
    to: "/settings/general",
    searchTerms: ["customization fork codex projects view chevron drag grip spinner dots"],
  },
  {
    id: "sidebar-show-location",
    title: msg("Location icon"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide location checkout icon"],
  },
  {
    id: "sidebar-role-display",
    title: msg("Role display"),
    to: "/settings/appearance",
    searchTerms: [
      "codex sidebar projects thread role orchestrator implementor names icons compact",
    ],
  },
  {
    id: "sidebar-show-provider",
    title: msg("Provider icon"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide provider codex claude icon"],
  },
  {
    id: "sidebar-show-model",
    title: msg("Model"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide model name"],
  },
  {
    id: "sidebar-show-model-version",
    title: msg("Model version"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide model version number"],
  },
  {
    id: "sidebar-show-effort",
    title: msg("Effort"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide reasoning effort"],
  },
  {
    id: "sidebar-show-issue-badge",
    title: msg("Issue badge"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide issue badge github number"],
  },
  {
    id: "sidebar-show-pull-request-badge",
    title: msg("Pull request badge"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread show hide pull request badge github state"],
  },
  {
    id: "sidebar-location-icon-style",
    title: msg("Location icon style"),
    to: "/settings/appearance",
    searchTerms: ["codex sidebar projects thread location icon worktree branch"],
  },
  {
    id: "sidebar-family-style",
    title: msg("Family style"),
    to: "/settings/appearance",
    searchTerms: [
      "codex sidebar projects thread family colors tint lines solid dashed orchestrator workers",
    ],
  },
  {
    id: "sidebar-line-color",
    title: msg("Line color"),
    to: "/settings/appearance",
    searchTerms: [
      "sidebar family checkout lines separator divider dashed solid color darker lighter",
    ],
  },
  {
    id: "section-folder-colors",
    title: msg("Section folder colors"),
    to: "/settings/appearance",
    searchTerms: ["customization fork section folder color tint icon"],
  },
  {
    id: "auto-organize-by-folder",
    title: msg("Keep projects organized by folder"),
    to: "/settings/general",
    searchTerms: ["customization fork sections folders automatic organize sort new projects"],
  },
  {
    id: "reveal-open-thread-in-sidebar",
    title: msg("Reveal the open thread in the sidebar"),
    to: "/settings/general",
    searchTerms: [
      "customization fork sidebar scroll expand collapsed project section follow active thread link navigate",
    ],
  },
  {
    id: "onboarding-codex-settings",
    title: msg("Codex settings during onboarding"),
    to: "/settings/general",
    searchTerms: ["customization fork onboarding import codex trust runtime mode projects"],
  },
  {
    id: "background-process-output",
    title: msg("Background process output"),
    to: "/settings/general",
    searchTerms: ["background command monitor shell task popup output logs stop cpu memory"],
  },
  {
    id: "running-commands-and-processes",
    title: msg("Show running commands and processes (experimental)"),
    to: "/settings/general",
    searchTerms: ["running command process spawned worker python cpu memory experimental"],
  },
  {
    id: "lineage-in-details",
    title: msg("Show Lineage in thread details"),
    to: "/settings/general",
    searchTerms: ["customization fork lineage thread details pane hide subagent parent"],
  },
  {
    id: "thread-details-redesign",
    title: msg("Redesigned Lineage"),
    to: "/settings/general",
    searchTerms: ["customization fork lineage subagent status model effort details clear"],
  },
  {
    id: "lineage-details-expanded",
    title: msg("Expand agent details by default"),
    to: "/settings/general",
    searchTerms: ["customization fork lineage subagent model effort details expand"],
  },
  {
    id: "lineage-auto-clear",
    title: msg("Clear finished agents automatically"),
    to: "/settings/general",
    searchTerms: ["customization fork lineage previous agents clear hide auto minutes hour"],
  },
  {
    id: "short-model-names",
    title: msg("Short model names"),
    to: "/settings/appearance",
    searchTerms: ["customization fork model name label short opus sonnet sol claude gpt icon"],
  },
  {
    id: "open-questions-automatically",
    title: msg("Open questions automatically"),
    to: "/settings/general",
    searchTerms: [
      "customization fork question popup floating panel answer anywhere other thread user input ask",
    ],
  },
  {
    id: "branch-picker-groups",
    title: msg("Branch picker groups"),
    to: "/settings/source-control",
    scope: null,
    searchTerms: ["customization fork branch picker current local remote collapse"],
  },
  {
    id: "agent-browser-in-panel",
    title: msg("Agent browser opens in the side panel"),
    to: "/settings/browser",
    searchTerms: ["customization fork browser preview agent side panel floating mini player"],
  },
  {
    id: "agent-browser-tab-limits",
    title: msg("Recover stalled agent tabs"),
    to: "/settings/browser",
    scope: "environment-defaults",
    searchTerms: [
      "customization fork browser preview agent tabs limits stuck loading hard reload retry recovery",
    ],
  },
  {
    id: "local-server-hide-rules",
    title: msg("Hidden local servers"),
    to: "/settings/browser",
    scope: "environment-defaults",
    searchTerms: [
      "customization fork browser preview local servers hide hidden restore process port range serena",
    ],
  },
  {
    id: "issue-upkeep-requires-approval",
    title: msg("Ask before agents create, split or move issues"),
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: ["github issues orchestration upkeep approval policy create split milestone"],
  },
  {
    id: "version-control-issues",
    title: msg("Issues in thread details"),
    to: "/settings/source-control",
    scope: null,
    searchTerms: ["customization fork github issues thread details version control milestones"],
  },
  {
    id: "plugin-skills",
    title: msg("Plugin skills in the composer"),
    to: "/settings/browser",
    searchTerms: ["customization fork plugin skills claude code dollar menu composer badge"],
  },
  {
    id: "fast-shimmer",
    title: msg("Faster activity shimmer"),
    to: "/settings/appearance",
    searchTerms: ["customization fork shimmer animation running activity speed motion"],
  },
  {
    id: "quiet-thread-minutes",
    title: msg("Quiet thread threshold"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["worker quiet stalled timeout inactivity parent wake"],
  },
  {
    id: "idle-agent-session",
    title: msg("Idle agent timeout"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["disconnect unload MCP tools memory idle agent session timeout minutes"],
  },
  {
    id: "keep-thread-titles-current",
    title: msg("Keep thread titles current"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["thread title rename regenerate automatic refresh luna sidebar names"],
  },
  {
    id: "model-tiers",
    title: msg("Model tiers and notes"),
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["tiers paired models preferences notes strengths weaknesses Claude Codex"],
  },
  {
    id: "model-roles",
    title: msg("Model roles"),
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: [
      "model roles orchestrator designer writer implementor delegate subagent builder reviewer routine complex level default model effort provider Claude Both Codex",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
