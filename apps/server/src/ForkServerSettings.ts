import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ForkPersistedServerSettingsFields = {
  usageLimitRecovery: Schema.optionalKey(Schema.Unknown),
};

/** Retain legacy usage-limit switch decoding before applying current defaults. */
export const migrateForkPersistedServerSettings = (
  saved: Omit<ServerSettings, "usageLimitRecovery"> & { readonly usageLimitRecovery?: unknown },
): ServerSettings => ({
  ...saved,
  usageLimitRecovery:
    saved.usageLimitRecovery === "off" ||
    saved.usageLimitRecovery === "wait" ||
    saved.usageLimitRecovery === "switch"
      ? saved.usageLimitRecovery
      : saved.autoResumeLimitedThreads || saved.snoozeLimitedThreads
        ? "wait"
        : "off",
});
