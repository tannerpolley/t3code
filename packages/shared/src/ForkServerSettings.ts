import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

/** Retired switches remain accepted from older clients; the mode owns the preference. */
export function normalizeUsageLimitRecoveryPatch(
  current: Pick<ServerSettings, "autoResumeLimitedThreads" | "snoozeLimitedThreads">,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (patch.usageLimitRecovery !== undefined)
    return {
      ...patch,
      autoResumeLimitedThreads:
        patch.usageLimitRecovery === "wait" && (patch.autoResumeLimitedThreads ?? true),
      snoozeLimitedThreads:
        patch.usageLimitRecovery === "wait" && (patch.snoozeLimitedThreads ?? true),
    };
  if (patch.autoResumeLimitedThreads === undefined && patch.snoozeLimitedThreads === undefined)
    return patch;
  const autoResume = patch.autoResumeLimitedThreads ?? current.autoResumeLimitedThreads;
  const snooze = patch.snoozeLimitedThreads ?? current.snoozeLimitedThreads;
  return {
    ...patch,
    usageLimitRecovery: autoResume || snooze ? "wait" : "off",
    autoResumeLimitedThreads: autoResume,
    snoozeLimitedThreads: snooze,
  };
}
