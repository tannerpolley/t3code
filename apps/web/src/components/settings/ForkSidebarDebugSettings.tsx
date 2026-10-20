import { useSyncExternalStore } from "react";
import {
  SIDEBAR_DEBUG_OPTIONS,
  sidebarDebugEnabled,
  setSidebarDebug,
  subscribeSidebarDebug,
} from "../sidebar/ForkSidebarDebug";
import { Switch } from "../ui/switch";
import { ForkSettingsRow } from "./ForkSettingsRow";
import { SettingsSection } from "./settingsLayout";

function DebugToggle({ option }: { readonly option: (typeof SIDEBAR_DEBUG_OPTIONS)[number] }) {
  const checked = useSyncExternalStore(subscribeSidebarDebug, () =>
    sidebarDebugEnabled(option.key),
  );
  return (
    <ForkSettingsRow
      title={option.title}
      description="Development preview only. Saved in this browser and applied immediately."
      control={
        <Switch
          aria-label={option.title}
          checked={checked}
          onCheckedChange={(value) => setSidebarDebug(option.key, value)}
        />
      }
    />
  );
}

export default function ForkSidebarDebugSettings() {
  return (
    <SettingsSection title="Debug">
      {SIDEBAR_DEBUG_OPTIONS.map((option) => (
        <DebugToggle key={option.key} option={option} />
      ))}
    </SettingsSection>
  );
}
