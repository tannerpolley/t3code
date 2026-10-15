import { useMemo } from "react";
import * as Equal from "effect/Equal";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";

const defaults = {
  sidebarThreadSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarThreadSortOrder,
  usageLimitRecovery: DEFAULT_UNIFIED_SETTINGS.usageLimitRecovery,
  usageLimitFallbackModels: DEFAULT_UNIFIED_SETTINGS.usageLimitFallbackModels,
  idleAgentSessionMinutes: DEFAULT_UNIFIED_SETTINGS.idleAgentSessionMinutes,
  keepRunningInBackground: DEFAULT_UNIFIED_SETTINGS.keepRunningInBackground,
};

/** Preserve the existing restore list and reset scope when fork rows move between pages. */
export function useForkSettingsRestore(settings: UnifiedSettings) {
  const changedSettingLabels = useMemo(
    () => ({
      sidebarThreadSortOrder:
        settings.sidebarThreadSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadSortOrder
          ? ["Thread order"]
          : [],
      usageLimitRecovery:
        settings.usageLimitRecovery !== DEFAULT_UNIFIED_SETTINGS.usageLimitRecovery
          ? ["Usage limit recovery"]
          : [],
      usageLimitFallbackModels: !Equal.equals(
        settings.usageLimitFallbackModels,
        DEFAULT_UNIFIED_SETTINGS.usageLimitFallbackModels,
      )
        ? ["Usage limit fallback models"]
        : [],
      idleAgentSessionMinutes:
        settings.idleAgentSessionMinutes !== DEFAULT_UNIFIED_SETTINGS.idleAgentSessionMinutes
          ? ["Idle agent timeout"]
          : [],
      keepRunningInBackground:
        settings.keepRunningInBackground !== DEFAULT_UNIFIED_SETTINGS.keepRunningInBackground
          ? ["Keep running in background"]
          : [],
    }),
    [settings],
  );
  return { changedSettingLabels, defaults };
}
