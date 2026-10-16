import * as Schema from "effect/Schema";
import {
  MAX_SIDEBAR_TEXT_SIZE,
  MIN_SIDEBAR_TEXT_SIZE,
  SidebarTextSize,
} from "@t3tools/contracts/settings";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const TEXT_SIZE_ROWS = [
  { key: "sidebarSectionTextSize", searchId: "sidebar-section-text-size" },
  { key: "sidebarProjectTextSize", searchId: "sidebar-project-text-size" },
  { key: "sidebarThreadTextSize", searchId: "sidebar-thread-text-size" },
  { key: "sidebarAgentTextSize", searchId: "sidebar-agent-text-size" },
  { key: "sidebarProcessTextSize", searchId: "sidebar-process-text-size" },
  { key: "sidebarDetailTextSize", searchId: "sidebar-detail-text-size" },
] as const;
const SIZES = Array.from(
  { length: MAX_SIDEBAR_TEXT_SIZE - MIN_SIDEBAR_TEXT_SIZE + 1 },
  (_, index) => MIN_SIDEBAR_TEXT_SIZE + index,
);
const isSidebarTextSize = Schema.is(SidebarTextSize);

export function ForkSidebarTextSizeSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  return TEXT_SIZE_ROWS.map(({ key, searchId }) => {
    const setting = searchableSetting(searchId);
    const size = settings[key];
    return (
      <ForkSettingsRow
        key={key}
        {...setting}
        description="Projects view only. Sizes scale with the interface font; Default uses this row's sidebar style."
        resetAction={
          size === null ? null : (
            <SettingResetButton
              label={setting.title}
              onClick={() => updateSettings({ [key]: null })}
            />
          )
        }
        control={
          <Select
            value={size === null ? "default" : String(size)}
            onValueChange={(value) => {
              const next = value === "default" ? null : Number(value);
              if (value !== null && isSidebarTextSize(next)) updateSettings({ [key]: next });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-28" aria-label={setting.title}>
              <SelectValue>{size === null ? "Default" : `${size}px`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="default">
                Default
              </SelectItem>
              {SIZES.map((size) => (
                <SelectItem hideIndicator key={size} value={String(size)}>
                  {size}px
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    );
  });
}
