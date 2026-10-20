import { FORK_SETTINGS_SEARCH_ITEMS } from "./ForkSettingsSearch";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

export type ForkSettingsPage = (typeof FORK_SETTINGS_SEARCH_ITEMS)[number]["to"];

export const FORK_SETTINGS_PAGES = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).filter(
  (page): page is ForkSettingsPage => FORK_SETTINGS_SEARCH_ITEMS.some((item) => item.to === page),
);
