import type {
  EnvironmentId,
  ServerProvider,
  UsageBucket,
  UsageProviderKind,
  UsageSummaryInput,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDayShort,
  formatHourShort,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { InfoIcon } from "lucide-react";
import { useMemo } from "react";

import { useUsage } from "../../state/usage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { attributeWindow } from "./usageLimitModels";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Covers a monthly window; the daily scan is never asked for more. */
const MAX_DAILY_DAYS = 32;
/** Model shades, strongest first, mixed from the provider's series colour. */
const SHADES = [100, 72, 52, 38, 26];
const ESTIMATE_NOTE =
  "Estimated from the usage your connected environments recorded, weighted by API-equivalent cost. Other devices and apps on the same account also count against the limit and are spread across these models.";

/** The usage query results a window's model split reads from. */
export interface LimitModelUsage {
  readonly hourly: readonly UsageBucket[];
  readonly daily: readonly UsageBucket[];
  readonly hourInput: UsageSummaryInput;
  readonly dayInput: UsageSummaryInput;
  readonly pending: boolean;
}

function usageProviderOf(driver: ServerProvider["driver"]): UsageProviderKind | null {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  if (driver === "grok") return "grok";
  return null;
}

/** When the pooled window opened: the earliest member start, or null without a clock. */
function poolWindowStart(pool: LimitPoolWindow, now: number): number | null {
  const starts = pool.members.flatMap(({ window }) => {
    if (window.resetsAt === undefined || window.windowDurationMins === undefined) return [];
    const start = Date.parse(window.resetsAt) - window.windowDurationMins * 60_000;
    return Number.isFinite(start) ? [Math.min(start, now)] : [];
  });
  return starts.length === 0 ? null : Math.min(...starts);
}

function shade(color: string, index: number): string {
  const percent = SHADES[index] ?? 26;
  return percent === 100 ? color : `color-mix(in oklab, ${color} ${percent}%, var(--background))`;
}

function formatPoints(points: number): string {
  return points > 0 && points < 0.1 ? "<0.1%" : `${points.toFixed(1)}%`;
}

/**
 * The usage a Limits view needs to split its windows by model: the last 24
 * hours hourly for short windows, and whole days back to the oldest window's
 * start for the rest (hourly scans stop at 24 hours). `untilTime` on the daily
 * query is ignored by the server but keys the cache, so each limits refresh
 * rescans instead of reusing the morning's numbers.
 */
export function useLimitModelUsage(
  presentations: Parameters<typeof collectLimitAccounts>[0],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  now: number,
): LimitModelUsage {
  const oldestStart = collectLimitPools(collectLimitAccounts(presentations), now)
    .flatMap((pool) => pool.windows)
    .reduce((oldest, window) => Math.min(oldest, poolWindowStart(window, now) ?? now), now);
  const days = Math.min(MAX_DAILY_DAYS, Math.ceil((now - oldestStart) / DAY_MS) + 1);
  const hourInput = useMemo(() => makeWindow(1, new Date(now), "hour"), [now]);
  const dayInput = useMemo(
    () => ({ ...makeWindow(days, new Date(now), "day"), untilTime: new Date(now).toISOString() }),
    [days, now],
  );
  const hourly = useUsage(hourInput, selectedEnvironmentIds);
  const daily = useUsage(dayInput, selectedEnvironmentIds);
  return {
    hourly: hourly.merged.buckets,
    daily: daily.merged.buckets,
    hourInput,
    dayInput,
    pending: hourly.isPending || daily.isPending,
  };
}

/**
 * Under a pooled window: a strip of the used share split by model, a legend,
 * and on request the window's history as stacked bars. Hourly for windows of a
 * day or less, daily otherwise.
 */
export function WindowModelBreakdown({
  pool,
  driver,
  color,
  usage,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly driver: ServerProvider["driver"];
  readonly color: string;
  readonly usage: LimitModelUsage;
  readonly now: number;
}) {
  const provider = usageProviderOf(driver);
  const start = poolWindowStart(pool, now);
  const hourlyResolution = start !== null && now - start <= DAY_MS;
  const timeZone = usage.dayInput.timeZone;
  const attribution = useMemo(
    () =>
      provider === null || start === null
        ? null
        : attributeWindow({
            buckets: hourlyResolution ? usage.hourly : usage.daily,
            provider,
            startMs: start,
            nowMs: now,
            usedPercent: pool.usedPercent,
            timeZone,
          }),
    [hourlyResolution, now, pool.usedPercent, provider, start, timeZone, usage.daily, usage.hourly],
  );
  if (provider === null || start === null || pool.usedPercent === 0) return null;
  if (attribution === null) {
    return (
      <p className="text-xs text-muted-foreground md:col-start-2">
        {usage.pending
          ? "Estimating usage by model…"
          : "No usage recorded by connected environments in this window."}
      </p>
    );
  }

  const periods = hourlyResolution
    ? enumerateHourStarts(usage.hourInput.sinceTime ?? "", usage.hourInput.untilTime ?? "").filter(
        (hour) => Date.parse(hour) + HOUR_MS > start,
      )
    : enumerateDays(localDay(start, timeZone), usage.dayInput.untilDay);
  const label = (period: string) =>
    hourlyResolution ? formatHourShort(period, timeZone) : formatDayShort(period);

  return (
    <div className="flex min-w-0 flex-col gap-2 md:col-start-2">
      <div
        role="img"
        aria-label={`${pool.label} by model, estimated: ${attribution.models
          .map((entry) => `${entry.model} ${formatPoints(entry.percent)}`)
          .join(", ")}`}
        className="flex h-1.5 overflow-hidden rounded-full bg-muted"
      >
        {attribution.models.map((entry, index) => (
          <div
            key={entry.model}
            style={{ width: `${entry.percent}%`, backgroundColor: shade(color, index) }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex cursor-default items-center gap-1 text-muted-foreground" />
            }
          >
            ≈ by model
            <InfoIcon className="size-3" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-72 text-xs">
            {ESTIMATE_NOTE}
          </TooltipPopup>
        </Tooltip>
        {attribution.models.map((entry, index) => (
          <span key={entry.model} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: shade(color, index) }}
            />
            <span className="truncate text-foreground">{entry.model}</span>
            <span className="text-muted-foreground tabular-nums">
              ≈{formatPoints(entry.percent)}
            </span>
          </span>
        ))}
      </div>
      <details className="group text-xs">
        <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
          {hourlyResolution ? "Hourly" : "Daily"} use in this window
        </summary>
        <WindowHistory
          periods={periods}
          label={label}
          attribution={attribution}
          colors={attribution.models.map((_, index) => shade(color, index))}
        />
      </details>
    </div>
  );
}

function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/** Stacked bars of estimated limit points per period; hover a bar for its numbers. */
function WindowHistory({
  periods,
  label,
  attribution,
  colors,
}: {
  readonly periods: readonly string[];
  readonly label: (period: string) => string;
  readonly attribution: NonNullable<ReturnType<typeof attributeWindow>>;
  readonly colors: readonly string[];
}) {
  const columns = periods.map((period) => ({
    period,
    values: attribution.periods.get(period) ?? [],
  }));
  const peak = Math.max(
    ...columns.map(({ values }) => values.reduce((sum, value) => sum + value, 0)),
  );
  if (!(peak > 0)) return null;
  const first = periods[0];
  const last = periods.at(-1);
  return (
    <div className="mt-2 flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground tabular-nums">
        Peak ≈{formatPoints(peak)} of the limit
      </span>
      <div className="flex h-28 items-end gap-px border-b border-border">
        {columns.map(({ period, values }) => (
          <Tooltip key={period}>
            <TooltipTrigger
              render={
                <div className="flex h-full min-w-0 flex-1 cursor-default flex-col-reverse hover:opacity-80" />
              }
            >
              {values.map((value, index) =>
                value > 0 ? (
                  <div
                    key={attribution.models[index]?.model ?? index}
                    style={{ height: `${(value / peak) * 100}%`, backgroundColor: colors[index] }}
                  />
                ) : null,
              )}
            </TooltipTrigger>
            <TooltipPopup side="top" className="text-xs">
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">{label(period)}</span>
                {values.map((value, index) =>
                  value > 0 ? (
                    <span key={attribution.models[index]?.model ?? index} className="tabular-nums">
                      {attribution.models[index]?.model}: ≈{formatPoints(value)}
                    </span>
                  ) : null,
                )}
              </div>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground uppercase">
        <span>{first === undefined ? "" : label(first)}</span>
        <span>{last === undefined ? "" : label(last)}</span>
      </div>
    </div>
  );
}
