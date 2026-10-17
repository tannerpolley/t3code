import type {
  EnvironmentId,
  ServerProvider,
  UsageBucket,
  UsageProviderKind,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatDuration,
  formatResetsIn,
  type LimitPace,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import { providerClients } from "../settings/providerDriverMeta";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor, PaceIcon, ResetCredits } from "./UsageLimits";
import { AccountAvatar, ExternalUsageLinks, LimitNotices } from "./UsageLimitsPooled";
import {
  attributeWindow,
  limitChartColumns,
  limitWindowOptions,
  localDay,
  poolWindowSpan,
  type WindowAttribution,
} from "./usageLimitModels";
import { type UsageChartSeries, UsageSeriesChart } from "./UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import {
  BreakdownRow,
  BreakdownTable,
  Metric,
  ModelLabel,
  SegmentedToggle,
  UsageBreakdown,
  type UsageBreakdownMode,
  UsageOverview,
  UsageProviderRow,
  UsageTotals,
  ValueCell,
} from "./UsageSections";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Covers a monthly window; the daily scan is never asked for more. */
const MAX_DAILY_DAYS = 32;
/** Model shades, strongest first, mixed from the provider's series colour. */
const SHADES = [100, 72, 52, 38, 26];
const ESTIMATE_NOTE =
  "Estimated from the usage your connected environments recorded, weighted by API-equivalent cost. Other devices and apps on the same account also count against the limit and are spread across these models.";
const PACE_LABEL: Record<LimitPace, string> = { ahead: "Ahead", on: "On pace", under: "Under" };

/** The usage query results the limit estimates read from. */
interface LimitModelUsage {
  readonly hourly: readonly UsageBucket[];
  readonly daily: readonly UsageBucket[];
  readonly hourInput: UsageSummaryInput;
  readonly dayInput: UsageSummaryInput;
  readonly pending: boolean;
}

/** One provider window of the selected kind: a row, a chart band, a breakdown column. */
interface LimitRow {
  readonly key: string;
  readonly provider: { readonly driverKind: ServerProvider["driver"]; readonly label: string };
  /** The provider's name, or the window's own when the provider has several of this kind. */
  readonly label: string;
  readonly color: string;
  readonly window: LimitPoolWindow;
}

function usageProviderOf(driver: ServerProvider["driver"]): UsageProviderKind | null {
  return (
    PROVIDER_ORDER.find((provider) => PROVIDER_PRESENTATION[provider].driverKind === driver) ?? null
  );
}

function shade(color: string, index: number): string {
  const percent = SHADES[index] ?? 26;
  return percent === 100 ? color : `color-mix(in oklab, ${color} ${percent}%, var(--background))`;
}

function formatPoints(points: number): string {
  return points > 0 && points < 0.1 ? "<0.1%" : `${points.toFixed(1)}%`;
}

/** The soonest reset that hands anything back; an untouched account resets to no effect. */
function nextRefill(window: LimitPoolWindow): LimitPoolWindow["resets"][number] | undefined {
  return window.resets.find((reset) => reset.restoresPercent > 0);
}

/** `+20% in 2h 10m` */
function formatRefill(reset: LimitPoolWindow["resets"][number], now: number): string {
  return `+${reset.restoresPercent}% ${reset.at <= now ? "now" : `in ${formatDuration(reset.at - now)}`}`;
}

/** A model's name, qualified by its window when its provider has several of this kind. */
function modelLabel(row: LimitRow, model: string): string {
  return row.label === row.provider.label ? model : `${model} · ${row.label}`;
}

type LimitWindowKind = LimitPoolWindow["kind"];

/**
 * The selected environments without hidden providers' accounts, matching what
 * `UsageLimitsSection` shows.
 */
function visibleLimitPresentations(
  presentations: LimitPresentations,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): LimitPresentations {
  const hiddenDrivers = new Set<ServerProvider["driver"]>(
    [...hiddenProviders].map((provider) => PROVIDER_PRESENTATION[provider].driverKind),
  );
  const isVisible = (driver: ServerProvider["driver"]) => !hiddenDrivers.has(driver);
  return new Map(
    [...presentations].flatMap(([id, presentation]) => {
      if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)) return [];
      const config = presentation.serverConfig;
      if (hiddenDrivers.size === 0 || config === null) return [[id, presentation] as const];
      return [
        [
          id,
          {
            ...presentation,
            serverConfig: {
              ...config,
              providers: config.providers?.filter((provider) => isVisible(provider.driver)),
              usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => isVisible(account.driver));
                return accounts.length === 0 && source.accounts.length > 0
                  ? []
                  : [{ ...source, accounts }];
              }),
            },
          },
        ] as const,
      ];
    }),
  );
}

/**
 * The page's side of Limits in the Cost and Tokens layout (the
 * `usageLimitModelBreakdown` client setting): the pools to show and the
 * window kind picked. A saved kind no provider reports right now falls back
 * without being forgotten.
 */
export function useLimitsOverview({
  showingLimits,
  selectedEnvironmentIds,
  hiddenProviders,
  now,
  savedWindow,
}: {
  readonly showingLimits: boolean;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
  readonly savedWindow: LimitWindowKind | undefined;
}) {
  const enabled = useClientSettings((settings) => settings.usageLimitModelBreakdown);
  const allPresentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const presentations = visibleLimitPresentations(
    allPresentations,
    selectedEnvironmentIds,
    hiddenProviders,
  );
  const pools =
    showingLimits && enabled ? collectLimitPools(collectLimitAccounts(presentations), now) : [];
  const windows = limitWindowOptions(pools);
  const window = windows.find((option) => option.value === savedWindow) ?? windows[0];
  return { enabled, presentations, pools, windows, window };
}

/** Picks the limit window kind in place of the usage period; `compact` is the narrow header's. */
export function LimitWindowPicker({
  windows,
  value,
  onValueChange,
  compact = false,
}: {
  readonly windows: ReturnType<typeof limitWindowOptions>;
  readonly value: LimitWindowKind;
  readonly onValueChange: (value: LimitWindowKind) => void;
  readonly compact?: boolean;
}) {
  if (!compact) {
    return (
      <SegmentedToggle
        ariaLabel="Limit window"
        value={value}
        options={windows}
        onValueChange={onValueChange}
      />
    );
  }
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = windows.find((candidate) => candidate.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        aria-label="Limit window"
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>{windows.find((option) => option.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {windows.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * The usage the limit estimates need: the last 24 hours hourly for short
 * windows, and whole days back to the oldest window's start for the rest
 * (hourly scans stop at 24 hours). `untilTime` on the daily query is ignored
 * by the server but keys the cache, so each limits refresh rescans instead of
 * reusing the morning's numbers.
 */
function useLimitModelUsage(
  pools: readonly LimitPool[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  now: number,
): LimitModelUsage {
  const oldestStart = pools
    .flatMap((pool) => pool.windows)
    .reduce((oldest, window) => Math.min(oldest, poolWindowSpan(window, now)?.start ?? now), now);
  const days = Math.min(MAX_DAILY_DAYS, Math.ceil((now - oldestStart) / DAY_MS) + 1);
  const hourInput = makeWindow(1, new Date(now), "hour");
  const dayInput = {
    ...makeWindow(days, new Date(now), "day"),
    untilTime: new Date(now).toISOString(),
  };
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
 * Each row's estimated split by model over one shared timeline, from the
 * earliest window start to now: hours when that is a day or less, days
 * otherwise.
 */
function estimateRows(
  rows: readonly LimitRow[],
  hourlyBuckets: readonly UsageBucket[],
  dailyBuckets: readonly UsageBucket[],
  hourInput: UsageSummaryInput,
  dayInput: UsageSummaryInput,
  now: number,
): {
  readonly hourly: boolean;
  readonly periods: readonly string[];
  readonly attributions: readonly (WindowAttribution | null)[];
} {
  const starts = rows.map((row) => poolWindowSpan(row.window, now)?.start ?? null);
  const known = starts.filter((start) => start !== null);
  if (known.length === 0) {
    return { hourly: false, periods: [], attributions: rows.map(() => null) };
  }
  const earliest = Math.min(...known);
  const hourly = now - earliest <= DAY_MS;
  const timeZone = dayInput.timeZone;
  const periods = hourly
    ? enumerateHourStarts(hourInput.sinceTime ?? "", hourInput.untilTime ?? "").filter(
        (hour) => Date.parse(hour) + HOUR_MS > earliest,
      )
    : enumerateDays(localDay(earliest, timeZone), dayInput.untilDay);
  const attributions = rows.map((row, index) => {
    const provider = usageProviderOf(row.provider.driverKind);
    const start = starts[index] ?? null;
    return provider === null || start === null || row.window.usedPercent === 0
      ? null
      : attributeWindow({
          buckets: hourly ? hourlyBuckets : dailyBuckets,
          provider,
          startMs: start,
          nowMs: now,
          usedPercent: row.window.usedPercent,
          timeZone,
        });
  });
  return { hourly, periods, attributions };
}

/** Who shares a pooled window, each with what is left and when it resets. */
function AccountList({ row, now }: { readonly row: LimitRow; readonly now: number }) {
  return (
    <div className="flex flex-col gap-1">
      {row.window.members.map(({ account, window }) => {
        const resetsIn = formatResetsIn(window, now);
        return (
          <span key={account.key} className="flex items-center gap-2">
            <AccountAvatar account={account} />
            <span className="min-w-0 truncate text-foreground">
              {account.displayName ?? row.provider.label}
            </span>
            <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
              {`${remainingPercent(window)}% left${resetsIn ? ` · ${resetsIn}` : ""}`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function EstimateNote() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Estimated. ${ESTIMATE_NOTE}`}
            className="inline-flex cursor-default text-muted-foreground"
          />
        }
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {ESTIMATE_NOTE}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Limits in the Cost and Tokens layout, for one window kind: what is left per
 * provider, the window's estimated use over time by provider or model, and
 * the same totals and breakdown shape. The page advances `now` on explicit
 * refresh rather than ticking.
 */
export function UsageLimitsOverview({
  presentations,
  pools,
  kind,
  selectedEnvironmentIds,
  now,
  cursorPrompt,
}: {
  readonly presentations: LimitPresentations;
  readonly pools: readonly LimitPool[];
  readonly kind: LimitWindowKind | undefined;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const usage = useLimitModelUsage(pools, selectedEnvironmentIds, now);
  const [chartBy, setChartBy] = useState<"provider" | "model">("provider");
  const [breakdown, setBreakdown] = useState<UsageBreakdownMode>("model");
  const rows = pools.flatMap((pool): LimitRow[] => {
    const windows = pool.windows.filter((window) => window.kind === kind);
    const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
    return windows.map((window) => ({
      key: `${pool.driver}:${window.id}`,
      provider: { driverKind: pool.driver, label },
      label: windows.length > 1 ? window.label : label,
      color: barColor(pool.driver),
      window,
    }));
  });
  const estimate = estimateRows(
    rows,
    usage.hourly,
    usage.daily,
    usage.hourInput,
    usage.dayInput,
    now,
  );
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);

  // The tightest window decides whether work can go on, so it leads.
  const topRow = rows.toSorted(
    (left, right) => left.window.remainingPercent - right.window.remainingPercent,
  )[0];
  if (topRow === undefined) {
    return (
      <div className="flex flex-col gap-8">
        {notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No provider on the selected environments reports subscription limits.
          </p>
        ) : null}
        {cursorPrompt}
        <ExternalUsageLinks links={externalLinks} />
        <LimitNotices notices={notices} />
      </div>
    );
  }

  const { hourly, periods, attributions } = estimate;
  const timeZone = usage.dayInput.timeZone;
  const emptyText = usage.pending ? "Estimating usage by model…" : "No activity in this window.";
  const byRow = limitChartColumns(attributions, periods, "provider");
  const chart = chartBy === "provider" ? byRow : limitChartColumns(attributions, periods, "model");
  const series = chart.bands.map(({ row: index, model }): UsageChartSeries => {
    const row = rows[index]!;
    const name = model === null ? undefined : attributions[index]?.models[model]?.model;
    return name === undefined || model === null
      ? { key: row.key, label: row.label, color: row.color, driverKind: row.provider.driverKind }
      : {
          key: `${row.key}:${name}`,
          label: modelLabel(row, name),
          color: shade(row.color, model),
          driverKind: row.provider.driverKind,
        };
  });
  const models = rows
    .flatMap((row, index) => (attributions[index]?.models ?? []).map((entry) => ({ row, entry })))
    .toSorted((left, right) => right.entry.percent - left.entry.percent);
  // Newest first and only periods with use, as in the Cost table.
  const timeRows = periods
    .map((period, index) => ({ period, values: byRow.columns[index] ?? [] }))
    .filter(({ values }) => values.some((value) => value > 0))
    .toReversed();
  const timeValueColumnWidth = `${60 / (byRow.bands.length + 1)}%`;
  const topRefill = nextRefill(topRow.window);
  const soonestRefill = rows
    .flatMap((row) => row.window.resets.filter((reset) => reset.restoresPercent > 0))
    .toSorted((left, right) => left.at - right.at)[0];
  const allWindows = pools.flatMap((pool) => pool.windows);
  const leftOf = (windowKind: LimitPoolWindow["kind"]) => {
    const left = allWindows
      .filter((window) => window.kind === windowKind)
      .map((window) => window.remainingPercent);
    return left.length === 0 ? "—" : `${Math.min(...left)}%`;
  };
  const creditAccounts = pools
    .flatMap((pool) => pool.accounts)
    .filter((account) => account.limits.resetCredits !== undefined);
  const banked = creditAccounts.reduce(
    (sum, account) => sum + (account.limits.resetCredits?.availableCount ?? 0),
    0,
  );

  return (
    <>
      <UsageOverview
        headline={`${topRow.window.remainingPercent}% left`}
        detail={
          <span className="inline-flex items-center gap-1.5">
            {[topRow.label, topRefill ? `↻ ${formatRefill(topRefill, now)}` : null]
              .filter(Boolean)
              .join(" · ")}
            {topRow.window.pace ? <PaceIcon pace={topRow.window.pace} /> : null}
          </span>
        }
        rows={rows.map((row) => {
          const refill = nextRefill(row.window);
          const accounts = row.window.members.length;
          return (
            <UsageProviderRow
              key={row.key}
              color={row.color}
              provider={row.provider}
              label={row.label}
              count={`${accounts} ${accounts === 1 ? "account" : "accounts"}`}
              value={`${row.window.remainingPercent}% left`}
              detail={`${row.window.usedPercent}% used${refill ? ` · ↻ ${formatRefill(refill, now)}` : ""}`}
              tooltip={<AccountList row={row} now={now} />}
            />
          );
        })}
        chartHeading={
          <span className="inline-flex items-center gap-1.5">
            {hourly ? "Hourly" : "Daily"} limit use
            <EstimateNote />
          </span>
        }
        chartActions={
          <SegmentedToggle
            ariaLabel="Limit chart series"
            value={chartBy}
            options={[
              { value: "provider", label: "Provider" },
              { value: "model", label: "Model" },
            ]}
            onValueChange={setChartBy}
          />
        }
        chart={
          <UsageSeriesChart
            series={series}
            periods={periods}
            columns={chart.columns}
            format={formatPoints}
            ariaLabel={`${hourly ? "Hourly" : "Daily"} estimated limit use by ${chartBy}`}
            referenceTime={usage.hourInput.untilTime}
            resolution={hourly ? "hour" : "day"}
            timeZone={timeZone}
          />
        }
      />

      <UsageTotals>
        <Metric label="5-hour left" value={leftOf("session")} />
        <Metric label="Weekly left" value={leftOf("weekly")} />
        <Metric
          label="Next refill"
          value={soonestRefill ? formatRefill(soonestRefill, now) : "—"}
        />
        <Metric label="Pace" value={topRow.window.pace ? PACE_LABEL[topRow.window.pace] : "—"} />
        <Metric label="Reset credits" value={creditAccounts.length === 0 ? "—" : String(banked)}>
          {creditAccounts.map((account) =>
            account.redeem && account.limits.resetCredits ? (
              <ResetCredits
                key={account.key}
                environmentId={account.redeem.environmentId}
                input={account.redeem.input}
                credits={account.limits.resetCredits}
                now={now}
                compact
                leading={creditAccounts.length > 1 ? <AccountAvatar account={account} /> : null}
              />
            ) : null,
          )}
        </Metric>
      </UsageTotals>

      <UsageBreakdown
        value={breakdown}
        onValueChange={setBreakdown}
        timeLabel={hourly ? "Hour" : "Day"}
      >
        {breakdown === "model" ? (
          <BreakdownTable
            columns={[
              { key: "model", label: "Model", width: "40%" },
              { key: "percent", label: "≈ % of limit", width: "20%" },
              { key: "share", label: "Share", width: "20%" },
              { key: "tokens", label: "Tokens", width: "20%" },
            ]}
            empty={models.length === 0}
            emptyText={emptyText}
          >
            {models.map(({ row, entry }) => (
              <BreakdownRow
                key={`${row.key}:${entry.model}`}
                label={<ModelLabel provider={row.provider} model={modelLabel(row, entry.model)} />}
              >
                <ValueCell>{formatPoints(entry.percent)}</ValueCell>
                <ValueCell muted>{formatPercent(entry.percent / row.window.usedPercent)}</ValueCell>
                <ValueCell muted>{formatTokens(entry.tokens)}</ValueCell>
              </BreakdownRow>
            ))}
          </BreakdownTable>
        ) : (
          <BreakdownTable
            columns={[
              { key: "period", label: hourly ? "Hour" : "Day", width: "40%" },
              ...byRow.bands.map(({ row }) => ({
                key: rows[row]!.key,
                label: rows[row]!.label,
                width: timeValueColumnWidth,
              })),
              { key: "total", label: "Total", width: timeValueColumnWidth },
            ]}
            empty={timeRows.length === 0}
            emptyText={emptyText}
          >
            {timeRows.map(({ period, values }) => (
              <BreakdownRow
                key={period}
                label={hourly ? formatHourShort(period, timeZone) : formatDayShort(period)}
              >
                {values.map((value, index) => (
                  <ValueCell key={byRow.bands[index]?.row ?? index} muted>
                    {formatPoints(value)}
                  </ValueCell>
                ))}
                <ValueCell>{formatPoints(values.reduce((sum, value) => sum + value, 0))}</ValueCell>
              </BreakdownRow>
            ))}
          </BreakdownTable>
        )}
      </UsageBreakdown>

      {cursorPrompt}
      <ExternalUsageLinks links={externalLinks} />
      <LimitNotices notices={notices} />
    </>
  );
}
