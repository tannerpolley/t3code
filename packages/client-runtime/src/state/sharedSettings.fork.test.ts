import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  findSharedSettingsMismatches,
  pickSharedServerSettings,
  splitSharedServerPatch,
} from "./sharedSettings.ts";

const primaryId = EnvironmentId.make("env-primary");
const boxId = EnvironmentId.make("env-box");
const restartCapabilities = { threadRestartContinuation: true };

describe("pickSharedServerSettings", () => {
  it("returns only the shared keys", () => {
    expect(
      Object.keys(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, restartCapabilities)).sort(),
    ).toEqual([
      "continueThreadsAfterServerUpdate",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleAfterDays",
      "sidebarAutoSettleOnMerge",
      "sourceControlWritingStyle",
      "textGenerationModelSelection",
      "usageLimitRecovery",
    ]);
  });
});

describe("shared usage limit recovery", () => {
  it("shares the new mode and keeps provider fallback models local", () => {
    const fallback = [{ instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" }];
    expect(
      splitSharedServerPatch({ usageLimitRecovery: "switch", usageLimitFallbackModels: fallback }),
    ).toEqual({
      sharedPatch: {
        usageLimitRecovery: "switch",
        autoResumeLimitedThreads: false,
        snoozeLimitedThreads: false,
      },
      localPatch: { usageLimitFallbackModels: fallback },
    });
  });
  it("maps an older client's switch change to the mode without losing its other switch", () => {
    expect(
      splitSharedServerPatch(
        { autoResumeLimitedThreads: false },
        { autoResumeLimitedThreads: true, snoozeLimitedThreads: true },
      ).sharedPatch,
    ).toEqual({
      usageLimitRecovery: "wait",
      autoResumeLimitedThreads: false,
      snoozeLimitedThreads: true,
    });
    expect(
      splitSharedServerPatch(
        { snoozeLimitedThreads: false },
        { autoResumeLimitedThreads: false, snoozeLimitedThreads: true },
      ).sharedPatch,
    ).toEqual({
      usageLimitRecovery: "off",
      autoResumeLimitedThreads: false,
      snoozeLimitedThreads: false,
    });
  });
  it("detects a mode mismatch even when the compatibility switches agree", () => {
    expect(
      findSharedSettingsMismatches({
        primaryEnvironmentId: primaryId,
        primarySettings: { ...DEFAULT_SERVER_SETTINGS, usageLimitRecovery: "switch" },
        environments: [
          {
            environmentId: boxId,
            label: "Box",
            syncEligible: true,
            settings: DEFAULT_SERVER_SETTINGS,
          },
        ],
      }),
    ).toEqual([{ environmentId: boxId, label: "Box" }]);
  });
});
