import { ProviderDriverKind, ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import { collectResetCreditAccounts } from "./ResetCreditAccounts";
import { describe, expect, it } from "vite-plus/test";
import {
  dueResetCreditReminders,
  RESET_CREDIT_REMINDER_MINUTES,
  resetCreditReminderBody,
  resetCreditReminderKey,
} from "./ResetCreditReminders";

const expiry = "2026-10-23T22:15:00.000Z";
const end = Date.parse(expiry);

describe("banked reset reminders", () => {
  it.each(RESET_CREDIT_REMINDER_MINUTES)(
    "shows the %i-minute reminder once at its boundary",
    (offsetMinutes) => {
      const now = end - offsetMinutes * 60_000;
      const reminder = { expiresAt: expiry, offsetMinutes };
      expect(dueResetCreditReminders([expiry], now, new Set())).toEqual([reminder]);
      expect(
        dueResetCreditReminders(
          [expiry],
          now,
          new Set([resetCreditReminderKey(expiry, offsetMinutes)]),
        ),
      ).toEqual([]);
    },
  );
  it("shows only the most recent missed offset and never catches up older offsets", () => {
    const now = end - 40 * 60_000;
    expect(dueResetCreditReminders([expiry], now, new Set())).toEqual([
      { expiresAt: expiry, offsetMinutes: 60 },
    ]);
    expect(
      dueResetCreditReminders([expiry], now, new Set([resetCreditReminderKey(expiry, 60)])),
    ).toEqual([]);
    expect(
      dueResetCreditReminders(
        [expiry],
        end - 20 * 60_000,
        new Set([resetCreditReminderKey(expiry, 60)]),
      ),
    ).toEqual([{ expiresAt: expiry, offsetMinutes: 30 }]);
  });
  it("ignores expired, invalid and distant credits while considering every available expiry", () => {
    expect(
      dueResetCreditReminders(
        [
          expiry,
          expiry,
          "invalid",
          new Date(end - 1).toISOString(),
          new Date(end + 48 * 3600_000).toISOString(),
        ],
        end,
        new Set(),
      ),
    ).toEqual([]);
    const second = new Date(end + 120 * 60_000).toISOString();
    expect(dueResetCreditReminders([expiry, second], end - 3 * 60_000, new Set())).toEqual([
      { expiresAt: expiry, offsetMinutes: 5 },
      { expiresAt: second, offsetMinutes: 180 },
    ]);
  });
  it("uses plain text with the actual remaining time and auto-use setting", () => {
    const body = resetCreditReminderBody("Codex", expiry, end - 180 * 60_000, true);
    expect(body).toContain("Codex banked reset expires in 3 hours (at ");
    expect(body).toContain("T3 will use it 10 minutes before it expires.");
    expect(resetCreditReminderBody("Codex", expiry, end - 40 * 60_000, false)).toContain(
      "expires in 40 minutes",
    );
    expect(resetCreditReminderBody("Claude", expiry, end - 60_000, false)).toContain(
      "expires in 1 minute",
    );
    expect(resetCreditReminderBody("Codex", expiry, end - 60_000, false)).not.toContain("T3 will");
  });
});

it("includes hub expiries when the same direct account reports no credits", () => {
  const driver = ProviderDriverKind.make("codex");
  const accountLimits = { checkedAt: expiry, windows: [] };
  const accounts = collectResetCreditAccounts(
    [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", email: "a@example.com" },
        checkedAt: expiry,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: accountLimits,
      },
    ],
    [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy",
        label: "Hub",
        checkedAt: expiry,
        accounts: [
          {
            id: "a",
            driver,
            email: "a@example.com",
            usageLimits: {
              ...accountLimits,
              resetCredits: { availableCount: 1, nextCreditId: "credit", expiries: [expiry] },
            },
          },
        ],
      },
    ],
  );
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.limits.resetCredits?.expiries).toEqual([expiry]);
  expect(accounts[0]?.input).toEqual({ sourceId: "hub", accountId: "a", creditId: "credit" });
});
