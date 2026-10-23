import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderConsumeResetCreditInput } from "./providerUsageLimits.ts";
import { ServerProvider, ServerProviderUpdatedPayload } from "./server.ts";

const decodeUpdate = Schema.decodeUnknownSync(ServerProviderUpdatedPayload);
const encodeUpdate = Schema.encodeSync(ServerProviderUpdatedPayload);

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("ignores removed weekly estimates in older snapshots", () => {
    const window = { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 10 };
    const decode = (entry: object) =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        usageLimits: { checkedAt: baseProviderSnapshot.checkedAt, windows: [entry] },
      }).usageLimits!.windows[0];
    expect(decode(window)).toEqual(window);
    expect(decode({ ...window, weeklyLimitPercentPerUsd: 0.5 })).toEqual(window);
    expect(decode({ ...window, weeklyLimitPercentPerUsd: -1 })).toEqual(window);
  });

  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      supportedRuntimeModes: ["approval-required", "future-mode", "full-access"],
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.plugins).toBeUndefined();
    expect(parsed.supportedRuntimeModes).toEqual(["approval-required", "full-access"]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });
});

it("preserves automatic reset results in the existing provider update payload", () => {
  const resetCreditAutoUse = {
    creditId: "credit-a",
    expiresAt: "2026-10-23T22:15:00.000Z",
    attemptedAt: "2026-10-23T22:05:00.000Z",
    status: "used",
  };
  const update = decodeUpdate({
    providers: [
      {
        ...baseProviderSnapshot,
        usageLimits: {
          checkedAt: baseProviderSnapshot.checkedAt,
          windows: [],
          resetCreditAutoUse,
        },
      },
    ],
  });
  expect(decodeUpdate(encodeUpdate(update)).providers[0]?.usageLimits?.resetCreditAutoUse).toEqual(
    resetCreditAutoUse,
  );
});

it("decodes old reset requests and preserves a displayed credit identity", () => {
  const decode = Schema.decodeUnknownSync(ProviderConsumeResetCreditInput);
  expect(decode({ instanceId: "codex" })).toEqual({ instanceId: "codex" });
  expect(decode({ instanceId: "codex", creditId: "credit-a" })).toEqual({
    instanceId: "codex",
    creditId: "credit-a",
  });
});
