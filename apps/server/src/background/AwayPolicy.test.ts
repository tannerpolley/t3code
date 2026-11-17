import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, RpcClientId, type BackgroundPolicySnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isAway } from "./AwayPolicy.ts";

const now = DateTime.makeUnsafe("2026-11-17T12:00:00Z");
const activity: BackgroundPolicySnapshot = {
  hostPower: {
    source: "electron-main",
    idle: "false",
    idleSeconds: 0,
    locked: "false",
    suspended: false,
    onBattery: "unknown",
    lowPowerMode: "unknown",
    thermalState: "unknown",
    stale: false,
    updatedAt: now,
  },
  leases: [],
  activeForegroundLeaseCount: 0,
  activeScopeKeys: [],
  shouldRunOpportunisticWork: false,
  updatedAt: now,
};

describe("Away policy", () => {
  it.each([
    { mode: "here", idle: 900, locked: "true", expected: false },
    { mode: "away", idle: 0, locked: "false", expected: true },
    { mode: "auto", idle: 299, locked: "false", expected: false },
    { mode: "auto", idle: 300, locked: "false", expected: true },
    { mode: "auto", idle: 0, locked: "true", expected: true },
  ] as const)(
    "resolves $mode at idle $idle, locked $locked",
    ({ mode, idle, locked, expected }) => {
      expect(
        isAway(
          { awayMode: mode, awayIdleMinutes: 5 },
          { ...activity, hostPower: { ...activity.hostPower, idleSeconds: idle, locked } },
        ),
      ).toBe(expected);
    },
  );
  it("uses the configured threshold and treats missing telemetry as away", () => {
    expect(
      isAway(
        { awayMode: "auto", awayIdleMinutes: 1 },
        { ...activity, hostPower: { ...activity.hostPower, idleSeconds: 60 } },
      ),
    ).toBe(true);
    expect(
      isAway(
        { awayMode: "auto", awayIdleMinutes: 5 },
        { ...activity, hostPower: { ...activity.hostPower, stale: true } },
      ),
    ).toBe(true);
  });
  it.each(["web", "mobile", "desktop-renderer"] as const)(
    "handles %s foreground leases without mistaking the phone for PC presence",
    (clientKind) => {
      const lease = {
        sessionId: AuthSessionId.make("session"),
        rpcClientId: RpcClientId.make(1),
        clientId: "client",
        clientKind,
        visible: true,
        focused: true,
        recentlyInteracted: false,
        scopes: [],
        updatedAt: now,
        expiresAt: DateTime.add(now, { seconds: 45 }),
      };
      const idleActivity = {
        ...activity,
        hostPower: { ...activity.hostPower, idleSeconds: 600 },
        leases: [lease],
      };
      expect(isAway({ awayMode: "auto", awayIdleMinutes: 5 }, idleActivity)).toBe(
        clientKind !== "web",
      );
      expect(
        isAway(
          { awayMode: "auto", awayIdleMinutes: 5 },
          { ...idleActivity, updatedAt: lease.expiresAt },
        ),
      ).toBe(true);
    },
  );
});
