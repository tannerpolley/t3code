import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { sidebarUsageProvidersToRefresh, refreshSidebarUsage } from "./forkUsageRefresh";

it("coalesces focus and visibility, throttles focus, and lets a manual refresh bypass the throttle", async () => {
  const id = EnvironmentId.make("sidebar-refresh-test");
  let complete!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = refreshSidebarUsage(id, refresh, true, 1_000);
  await refreshSidebarUsage(id, refresh, true, 1_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  complete();
  await pending;
  await refreshSidebarUsage(id, refresh, true, 30_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  const fresh = vi.fn(async () => "fresh");
  expect(await refreshSidebarUsage(id, fresh, false, 30_999)).toBe("fresh");
  await refreshSidebarUsage(id, fresh, true, 60_999);
  expect(fresh).toHaveBeenCalledTimes(2);
});

it("skips a recent live reading, but catches up an old cached reading or passed reset", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    models: [],
    slashCommands: [],
    skills: [],
    checkedAt: new Date(now).toISOString(),
    usageLimits: { checkedAt: new Date(now).toISOString(), windows: [] },
  };
  const oldCodex = {
    ...provider,
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: new Date(now - 30_000).toISOString(), windows: [] },
  };
  expect(sidebarUsageProvidersToRefresh([provider], now)).toEqual([]);
  expect(sidebarUsageProvidersToRefresh([provider, oldCodex], now)).toEqual([oldCodex]);
  expect(sidebarUsageProvidersToRefresh([provider, oldCodex], now, false)).toEqual([
    provider,
    oldCodex,
  ]);
  expect(sidebarUsageProvidersToRefresh([{ ...oldCodex, enabled: false }], now)).toEqual([]);
  expect(
    sidebarUsageProvidersToRefresh(
      [
        {
          ...provider,
          usageLimits: {
            checkedAt: new Date(now - 30_000).toISOString(),
            windows: [],
          },
        },
      ],
      now,
    ),
  ).toHaveLength(1);
  expect(
    sidebarUsageProvidersToRefresh(
      [
        {
          ...provider,
          usageLimits: {
            checkedAt: new Date(now).toISOString(),
            windows: [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 99,
                resetsAt: new Date(now).toISOString(),
              },
            ],
          },
        },
      ],
      now,
    ),
  ).toHaveLength(1);
});
