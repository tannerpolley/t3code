import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { splitSharedServerPatch } from "./sharedSettings.ts";

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
});
