import { prepareResetCreditUsage } from "./ResetCreditUsageNavigation";
import { useAtomValue } from "@effect/atom-react";
import { environmentPresentations } from "../state/presentation";
import { collectResetCreditAccounts } from "./ResetCreditAccounts";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { focusAppWindow, notificationTag } from "../threadNotifications";
import {
  dueResetCreditReminders,
  RESET_CREDIT_REMINDER_MINUTES,
  resetCreditReminderBody,
  resetCreditReminderKey,
} from "./ResetCreditReminders";
import { toastManager } from "./ui/toast";

export function ResetCreditReminderCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentResetCreditReminders key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentResetCreditReminders({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const presentation = useAtomValue(environmentPresentations.presentationsWithProvidersAtom).get(
    environmentId,
  );
  const accounts = collectResetCreditAccounts(
    presentation?.serverConfig?.providers ?? [],
    presentation?.serverConfig?.usageLimitSources ?? [],
    environmentId,
  );
  const remindersEnabled = useClientSettings((settings) => settings.resetCreditReminders);
  const autoUse = useEnvironmentSettings(
    environmentId,
    (settings) => settings.autoUseExpiringResetCredits,
  );
  const navigate = useNavigate();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const openUsage = () => {
      focusAppWindow();
      void window.desktopBridge?.revealWindow?.().catch(() => undefined);
      prepareResetCreditUsage();
      void navigate({ to: "/usage" });
    };
    const tick = async () => {
      const show = () => {
        if (stopped) return;
        clearTimeout(timer);
        const now = Date.now();
        let nextAt = Infinity;
        for (const account of accounts) {
          const limits = account.limits;
          const prefix = `t3:reset-credit:${account.key}:`;
          const label = account.label;
          const nativeAllowed =
            typeof Notification !== "undefined" && Notification.permission === "granted";
          const showNative = (body: string, tag: string) => {
            if (!nativeAllowed) return false;
            try {
              const notification = new Notification("Banked reset", {
                body,
                tag: notificationTag(tag),
                silent: false,
              });
              notification.addEventListener("click", () => {
                notification.close();
                openUsage();
              });
              return true;
            } catch {
              // Some browsers expose Notification but reject desktop presentation.
              return false;
            }
          };
          if (remindersEnabled && nativeAllowed && limits?.resetCredits?.availableCount) {
            const expiries = limits.resetCredits.expiries ?? [];
            const shown = new Set(
              expiries.flatMap((expiry) =>
                RESET_CREDIT_REMINDER_MINUTES.flatMap((offset) => {
                  const key = resetCreditReminderKey(expiry, offset);
                  return localStorage.getItem(prefix + key) ? [key] : [];
                }),
              ),
            );
            for (const reminder of dueResetCreditReminders(expiries, now, shown)) {
              const key =
                prefix + resetCreditReminderKey(reminder.expiresAt, reminder.offsetMinutes);
              if (
                showNative(resetCreditReminderBody(label, reminder.expiresAt, now, autoUse), key)
              ) {
                localStorage.setItem(key, "shown");
              }
            }
            for (const expiry of expiries) {
              for (const offset of RESET_CREDIT_REMINDER_MINUTES) {
                const at = Date.parse(expiry) - offset * 60_000;
                if (at > now) nextAt = Math.min(nextAt, at);
              }
            }
          }
          const result = limits?.resetCreditAutoUse;
          if (result) {
            const key = `${prefix}result:${result.creditId}:${result.expiresAt}:${result.status}`;
            if (!localStorage.getItem(key)) {
              const body =
                result.status === "used"
                  ? `Used your banked ${label} reset before it expired`
                  : `Could not use your banked ${label} reset before expiry. Use now from Usage.`;
              showNative(body, key);
              toastManager.add({
                type: result.status === "used" ? "success" : "error",
                title: body,
                actionProps: {
                  children: result.status === "used" ? "View usage" : "Use now",
                  onClick: openUsage,
                },
              });
              localStorage.setItem(key, "shown");
            }
          }
        }
        if (!stopped && nextAt < Infinity)
          timer = setTimeout(() => void tick(), Math.min(nextAt - now, 2_147_483_647));
      };
      try {
        // Web Locks serialises the localStorage check and notification across app windows.
        if (navigator.locks) await navigator.locks.request("t3-reset-credit-reminders", show);
        else show();
      } catch {
        // Notification presentation and storage can be unavailable in browser privacy modes.
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void tick();
    };
    void tick();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [accounts, remindersEnabled, autoUse, navigate]);
  return null;
}
