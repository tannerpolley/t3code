import { T, useGT } from "gt-react";
import * as Schema from "effect/Schema";
import {
  MAX_SIDEBAR_TEXT_SIZE,
  MIN_SIDEBAR_TEXT_SIZE,
  SidebarTextSize,
} from "@t3tools/contracts/settings";
import { useClientSettings, updateClientSettings as updateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingResetButton } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const TEXT_SIZE_ROWS = [
  { key: "sidebarSectionTextSize", searchId: "sidebar-section-text-size" },
  { key: "sidebarProjectTextSize", searchId: "sidebar-project-text-size" },
  { key: "sidebarThreadTextSize", searchId: "sidebar-thread-text-size" },
  { key: "sidebarAgentTextSize", searchId: "sidebar-agent-text-size" },
  { key: "sidebarProcessTextSize", searchId: "sidebar-process-text-size" },
] as const;
const SIZES = Array.from(
  { length: MAX_SIDEBAR_TEXT_SIZE - MIN_SIDEBAR_TEXT_SIZE + 1 },
  (_, index) => MIN_SIDEBAR_TEXT_SIZE + index,
);
const isSidebarTextSize = Schema.is(SidebarTextSize);

export function ForkSidebarTextSizeSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings();
  return TEXT_SIZE_ROWS.map(({ key, searchId }) => {
    const setting = searchableSetting(searchId);
    const size = settings[key];
    return (
      <ForkSettingsRow
        key={key}
        {...setting}
        description={gt(
          "Projects view only. Sizes scale with the interface font; Default uses this row's sidebar style.",
        )}
        resetAction={
          size === null ? null : (
            <SettingResetButton
              ariaLabel={gt("Reset {setting} to default", { setting: setting.title })}
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
              <SelectValue>{size === null ? gt("Default") : `${size}px`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="default">
                <T>Default</T>
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
