import { readUsagePagePreferences, saveUsagePagePreferences } from "./usage/usagePagePreferences";
import { render } from "../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ClientSettings,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as readonly ServerProvider[],
  reminders: true,
  autoUse: true,
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: null },
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () =>
    new Map([
      [
        EnvironmentId.make("reset-test"),
        { serverConfig: { providers: state.providers, usageLimitSources: [] } },
      ],
    ]),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => [EnvironmentId.make("reset-test")],
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: Pick<ClientSettings, "resetCreditReminders">) => unknown,
  ) => select({ resetCreditReminders: state.reminders }),
  useEnvironmentSettings: (
    _id: EnvironmentId,
    select: (settings: Pick<UnifiedSettings, "autoUseExpiringResetCredits">) => unknown,
  ) => select({ autoUseExpiringResetCredits: state.autoUse }),
}));

import { ResetCreditReminderCoordinator } from "./ResetCreditReminderCoordinator";

const now = Date.parse("2026-10-22T12:00:00Z");
const expiry = "2026-10-22T12:40:00.000Z";
const storageKey = `t3:reset-credit:reset-test:codex:reset@example.com::${expiry}:60`;

function setup() {
  state.reminders = true;
  state.autoUse = true;
  state.providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      models: [],
      slashCommands: [],
      skills: [],
      auth: { status: "authenticated", email: "reset@example.com" },
      checkedAt: "2026-10-22T12:00:00Z",
      usageLimits: {
        checkedAt: "2026-10-22T12:00:00Z",
        windows: [],
        resetCredits: { availableCount: 1, expiries: [expiry] },
      },
    },
  ];
  localStorage.removeItem(storageKey);
}

it("shows one audible missed reminder across simultaneous coordinators and remounts, and opens Usage on click", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(now);
  const savedPreferences = readUsagePagePreferences();
  using _restorePreferences = {
    [Symbol.dispose]: () => saveUsagePagePreferences(savedPreferences),
  };
  saveUsagePagePreferences({ metric: "cost", windowDays: 30, hiddenProviders: ["codex"] });
  const clicks: Array<() => void> = [];
  using notifications = vi
    .spyOn(window, "Notification")
    .mockImplementation(function (_title, options) {
      return {
        tag: options?.tag,
        close: vi.fn(),
        addEventListener: (_event: string, click: () => void) => clicks.push(click),
      } as unknown as Notification;
    });
  Object.defineProperty(notifications, "permission", { get: () => "granted" });
  await using screen = await render(
    <>
      <ResetCreditReminderCoordinator />
      <ResetCreditReminderCoordinator />
    </>,
  );
  await vi.waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
  expect(notifications.mock.calls[0]?.[1]).toMatchObject({
    silent: false,
    body: expect.stringContaining("Codex banked reset expires in 40 minutes"),
  });
  expect(notifications.mock.calls[0]?.[1]?.tag?.length).toBeLessThanOrEqual(16);
  expect(localStorage.getItem(storageKey)).toBe("shown");
  clicks[0]!();
  expect(readUsagePagePreferences()).toMatchObject({ metric: "limits", hiddenProviders: [] });
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/usage"));
  await screen.rerender(<ResetCreditReminderCoordinator key="reloaded" />);
  await vi.waitFor(() =>
    expect(
      navigator.locks.request("t3-reset-credit-reminders", () => notifications.mock.calls.length),
    ).resolves.toBe(1),
  );
  localStorage.removeItem(storageKey);
});

it("leaves an undelivered reminder available until permission is granted and respects opt-out", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(now);
  let permission: NotificationPermission = "denied";
  using notifications = vi
    .spyOn(window, "Notification")
    .mockImplementation(function (_title, options) {
      return {
        tag: options?.tag,
        close: vi.fn(),
        addEventListener: vi.fn(),
      } as unknown as Notification;
    });
  Object.defineProperty(notifications, "permission", { get: () => permission });
  await using screen = await render(<ResetCreditReminderCoordinator />);
  await navigator.locks.request("t3-reset-credit-reminders", () => {});
  expect(notifications).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBeNull();
  permission = "granted";
  state.reminders = false;
  await screen.rerender(<ResetCreditReminderCoordinator />);
  await navigator.locks.request("t3-reset-credit-reminders", () => {});
  expect(notifications).not.toHaveBeenCalled();
  state.reminders = true;
  await screen.rerender(<ResetCreditReminderCoordinator />);
  await vi.waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
  localStorage.removeItem(storageKey);
});
