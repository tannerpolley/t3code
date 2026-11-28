// @effect-diagnostics globalDate:off -- Calendar days and zone offsets are wall-clock values Intl reads from Date.
import { UsageDay } from "@t3tools/contracts";

export interface UsageWindow {
  readonly sinceDay: UsageDay;
  readonly untilDay: UsageDay;
  readonly timeZone: string;
  readonly days: number;
}

/** Calendar window ending on `now`'s date in `timeZone`. Throws when `timeZone` is not an IANA name. */
export function usageWindow(days: number, now: Date, timeZone: string): UsageWindow {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const untilDay = format.format(now);
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    days,
  };
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value("hour");
  return Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour === 24 ? 0 : hour,
    value("minute"),
    value("second"),
  );
}

/** UTC instant of `day` at 00:00 in `timeZone`. The offset is read at local midnight, so DST is included. */
export function zonedDayStartIso(day: string, timeZone: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map((part) => Number.parseInt(part, 10));
  const localMidnightUtc = Date.UTC(year, month - 1, date);
  const offsetAt = (ms: number) => zonedParts(ms, timeZone) - ms;
  const first = localMidnightUtc - offsetAt(localMidnightUtc);
  return new Date(localMidnightUtc - offsetAt(first)).toISOString();
}

export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
