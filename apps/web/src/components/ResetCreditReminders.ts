export const RESET_CREDIT_REMINDER_MINUTES = [1440, 720, 360, 180, 60, 30, 10, 5, 1] as const;

export function resetCreditReminderKey(expiresAt: string, offsetMinutes: number): string {
  return `${expiresAt}:${offsetMinutes}`;
}

export function dueResetCreditReminders(
  expiries: readonly string[],
  now: number,
  alreadyShown: ReadonlySet<string>,
) {
  return [...new Set(expiries)].flatMap((expiresAt) => {
    const remaining = Date.parse(expiresAt) - now;
    if (!Number.isFinite(remaining) || remaining <= 0) return [];
    // Pick the latest crossed offset first; never replay older reminders on a later visit.
    const offsetMinutes = RESET_CREDIT_REMINDER_MINUTES.findLast(
      (minutes) => remaining <= minutes * 60_000,
    );
    if (
      offsetMinutes === undefined ||
      alreadyShown.has(resetCreditReminderKey(expiresAt, offsetMinutes))
    )
      return [];
    return [{ expiresAt, offsetMinutes }];
  });
}

export function resetCreditReminderBody(
  provider: string,
  expiresAt: string,
  now: number,
  autoUse: boolean,
): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  const duration =
    minutes >= 60 && minutes % 60 === 0
      ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
      : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const time = new Date(expiresAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${provider} banked reset expires in ${duration} (at ${time}).${autoUse ? " T3 will use it 10 minutes before it expires." : ""}`;
}
