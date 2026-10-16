import type { SettingsSearchItem } from "./settingsSearch";

export const FORK_SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktrees-location",
    title: "Worktree location",
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: [
      "worktree location folder directory path drive external disk inside project local .worktrees customizations",
    ],
  },
  {
    id: "interface-zoom",
    title: "Interface zoom",
    to: "/settings/appearance",
    searchTerms: ["zoom scale size larger smaller display resolution ctrl plus minus"],
    desktopOnly: true,
  },
  {
    id: "thread-order",
    title: "Thread order",
    to: "/settings/general",
    searchTerms: ["sort threads sidebar projects last user message created recent"],
  },
  {
    id: "usage-limit-recovery",
    title: "Usage limit recovery",
    to: "/settings/general",
    searchTerms: [
      "auto resume snooze usage quota rate limit reset switch provider fallback model effort recover continue",
    ],
  },
  {
    id: "keep-running-in-background",
    title: "Keep running in background",
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
    title: "Toggle button position",
    to: "/settings/appearance",
    secondary: true,
    searchTerms: ["customization fork sidebar toggle collapse left right corner"],
  },
  {
    id: "project-icon-fallback",
    title: "Default project icon",
    to: "/settings/appearance",
    searchTerms: ["project icon folder initials monogram letters favicon sidebar"],
  },
  {
    id: "organize-by-folder",
    title: "Organize by folder",
    to: "/settings/general",
    searchTerms: ["customization fork sections subsections folders workspaces organize mirror"],
  },
  {
    id: "projects-view",
    title: "Projects view",
    to: "/settings/general",
    searchTerms: ["customization fork projects view sections activity sidebar mode"],
  },
  {
    id: "sidebar-section-text-size",
    title: "Section names text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller section names headers",
    ],
  },
  {
    id: "sidebar-project-text-size",
    title: "Project names text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller project names repository",
    ],
  },
  {
    id: "sidebar-thread-text-size",
    title: "Thread rows text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller thread rows titles",
    ],
  },
  {
    id: "sidebar-agent-text-size",
    title: "Agent rows text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller agent work rows workers tasks subagents",
    ],
  },
  {
    id: "sidebar-process-text-size",
    title: "Process rows text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller process rows commands shell",
    ],
  },
  {
    id: "sidebar-detail-text-size",
    title: "Detail columns text size",
    to: "/settings/general",
    searchTerms: [
      "customization fork projects view sidebar font size larger smaller detail columns count time model effort usage",
    ],
  },
  {
    id: "codex-style-sidebar",
    title: "Codex-style project sidebar",
    to: "/settings/general",
    searchTerms: ["customization fork codex projects view chevron drag grip spinner dots"],
  },
  {
    id: "section-folder-colors",
    title: "Section folder colors",
    to: "/settings/appearance",
    searchTerms: ["customization fork section folder color tint icon"],
  },
  {
    id: "auto-organize-by-folder",
    title: "Keep projects organized by folder",
    to: "/settings/general",
    searchTerms: ["customization fork sections folders automatic organize sort new projects"],
  },
  {
    id: "reveal-open-thread-in-sidebar",
    title: "Reveal the open thread in the sidebar",
    to: "/settings/general",
    searchTerms: [
      "customization fork sidebar scroll expand collapsed project section follow active thread link navigate",
    ],
  },
  {
    id: "top-back-button",
    title: "Back button at the top",
    to: "/settings/appearance",
    searchTerms: ["customization fork back button settings sidebar top left"],
  },
  {
    id: "onboarding-codex-settings",
    title: "Codex settings during onboarding",
    to: "/settings/general",
    searchTerms: ["customization fork onboarding import codex trust runtime mode projects"],
  },
  {
    id: "background-process-output",
    title: "Background process output",
    to: "/settings/general",
    searchTerms: ["background command monitor shell task popup output logs stop cpu memory"],
  },
  {
    id: "running-commands-and-processes",
    title: "Show running commands and processes (experimental)",
    to: "/settings/general",
    searchTerms: ["running command process spawned worker python cpu memory experimental"],
  },
  {
    id: "lineage-in-details",
    title: "Show Lineage in thread details",
    to: "/settings/general",
    searchTerms: ["customization fork lineage thread details pane hide subagent parent"],
  },
  {
    id: "thread-details-redesign",
    title: "Redesigned Lineage",
    to: "/settings/general",
    searchTerms: ["customization fork lineage subagent status model effort details clear"],
  },
  {
    id: "lineage-details-expanded",
    title: "Expand agent details by default",
    to: "/settings/general",
    searchTerms: ["customization fork lineage subagent model effort details expand"],
  },
  {
    id: "lineage-auto-clear",
    title: "Clear finished agents automatically",
    to: "/settings/general",
    searchTerms: ["customization fork lineage previous agents clear hide auto minutes hour"],
  },
  {
    id: "short-model-names",
    title: "Short model names",
    to: "/settings/appearance",
    searchTerms: ["customization fork model name label short opus sonnet sol claude gpt icon"],
  },
  {
    id: "open-questions-automatically",
    title: "Open questions automatically",
    to: "/settings/general",
    searchTerms: [
      "customization fork question popup floating panel answer anywhere other thread user input ask",
    ],
  },
  {
    id: "branch-picker-groups",
    title: "Branch picker groups",
    to: "/settings/source-control",
    scope: null,
    searchTerms: ["customization fork branch picker current local remote collapse"],
  },
  {
    id: "agent-browser-in-panel",
    title: "Agent browser opens in the side panel",
    to: "/settings/integrations",
    searchTerms: ["customization fork browser preview agent side panel floating mini player"],
  },
  {
    id: "agent-browser-tab-limits",
    title: "Agent browser tab limits",
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: ["customization fork browser preview agent tabs cap three stuck reload retry"],
  },
  {
    id: "local-server-hide-rules",
    title: "Hidden local servers",
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: [
      "customization fork browser preview local servers hide hidden restore process port range serena",
    ],
  },
  {
    id: "issue-upkeep-requires-approval",
    title: "Ask before agents create, split or move issues",
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: ["github issues orchestration upkeep approval policy create split milestone"],
  },
  {
    id: "version-control-issues",
    title: "Issues in thread details",
    to: "/settings/source-control",
    scope: null,
    searchTerms: ["customization fork github issues thread details version control milestones"],
  },
  {
    id: "issues-page",
    title: "Issues page",
    to: "/settings/source-control",
    scope: null,
    searchTerms: ["customization fork github issues page browser sidebar repositories filters pin"],
  },
  {
    id: "chat-math",
    title: "Math in chat",
    to: "/settings/general",
    searchTerms: ["customization fork latex katex math formulas equations markdown dollar"],
  },
  {
    id: "plugin-skills",
    title: "Plugin skills in the composer",
    to: "/settings/integrations",
    searchTerms: ["customization fork plugin skills claude code dollar menu composer badge"],
  },
  {
    id: "usage-limit-model-breakdown",
    title: "Limits page like Cost and Tokens",
    to: "/settings/general",
    searchTerms: [
      "customization fork usage limits window models breakdown weekly session estimate chart",
    ],
  },
  {
    id: "sidebar-five-hour-usage",
    title: "5-hour usage in the sidebar",
    to: "/settings/general",
    searchTerms: [
      "customization fork usage limits five hour 5h session quota left sidebar footer claude codex",
    ],
  },
  {
    id: "daily-usage-meter",
    title: "Daily usage in the sidebar",
    to: "/settings/general",
    searchTerms: [
      "customization fork usage limits weekly daily budget pace workday sidebar meter claude codex",
    ],
  },
  {
    id: "sidebar-weekly-usage",
    title: "Weekly usage in the sidebar",
    to: "/settings/general",
    searchTerms: [
      "customization fork usage limits weekly quota left sidebar footer claude codex 7d",
    ],
  },
  {
    id: "fast-shimmer",
    title: "Faster activity shimmer",
    to: "/settings/appearance",
    searchTerms: ["customization fork shimmer animation running activity speed motion"],
  },
  {
    id: "idle-agent-session",
    title: "Idle agent timeout",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["disconnect unload MCP tools memory idle agent session timeout minutes"],
  },
  {
    id: "keep-thread-titles-current",
    title: "Keep thread titles current",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["thread title rename regenerate automatic refresh luna sidebar names"],
  },
  {
    id: "model-roles",
    title: "Model roles",
    to: "/settings/customizations",
    scope: "environment-defaults",
    searchTerms: [
      "model roles orchestrator delegate subagent builder checker reviewer default model effort",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
