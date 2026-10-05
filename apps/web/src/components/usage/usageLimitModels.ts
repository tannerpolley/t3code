import type { UsageBucket, UsageProviderKind } from "@t3tools/contracts";
import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Models past this many fold into one "Other models" row so the legend stays readable. */
const MAX_MODELS = 5;
export const OTHER_MODELS = "Other models";

export interface WindowModelShare {
  readonly model: string;
  /** Estimated points of the limit this model used, 0..usedPercent. */
  readonly percent: number;
  /** Tokens the model processed inside the window. */
  readonly tokens: number;
}

export interface WindowAttribution {
  /** Largest first; sums to the window's used percent. */
  readonly models: readonly WindowModelShare[];
  /** Per period key (`hourStart` or `day`), points of the limit per model, aligned to `models`. */
  readonly periods: ReadonlyMap<string, readonly number[]>;
}

/** UTC instant of local midnight for a `YYYY-MM-DD` day. */
export function dayStartMs(day: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(utcMidnight);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return utcMidnight - (wall - utcMidnight);
}

/** The `YYYY-MM-DD` day an instant falls on in the time zone. */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** When one account's window opened (clamped to now) and resets, or null without a clock. */
export function memberWindowSpan(
  window: LimitPoolWindow["members"][number]["window"],
  now: number,
): { readonly start: number; readonly end: number } | null {
  if (window.resetsAt === undefined || window.windowDurationMins === undefined) return null;
  const end = Date.parse(window.resetsAt);
  const start = Math.min(end - window.windowDurationMins * 60_000, now);
  return Number.isFinite(start) ? { start, end } : null;
}

/**
 * When the pooled window opened and resets: the earliest-opening member's
 * span (its start clamped to now), or null when no member has a clock.
 */
export function poolWindowSpan(
  pool: LimitPoolWindow,
  now: number,
): { readonly start: number; readonly end: number } | null {
  let span: { readonly start: number; readonly end: number } | null = null;
  for (const { window } of pool.members) {
    const member = memberWindowSpan(window, now);
    if (member && (span === null || member.start < span.start)) span = member;
  }
  return span;
}

/** Share of a weekly limit each full Monday–Friday day may spend. */
const WORKDAY_SHARE_PERCENT = 20;

/**
 * Rolling daily pace for a weekly limit: each local Monday–Friday is worth
 * 20% of the limit, weighted by how much of that calendar day lies inside the
 * window, and unused room carries forward. The budget covers every workday
 * from the window's start through the end of today, capped at 100%.
 */
export function dailyPaceBudget(input: {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly now: number;
  readonly timeZone: string;
}): {
  readonly budgetPercent: number;
  readonly isWorkday: boolean;
  readonly workdayWeightsSoFar: number;
} {
  const today = localDay(input.now, input.timeZone);
  let weights = 0;
  let isWorkday = false;
  for (let day = localDay(input.windowStart, input.timeZone); day <= today; day = nextDay(day)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const workday = weekday >= 1 && weekday <= 5;
    if (day === today) isWorkday = workday;
    if (!workday) continue;
    // Local midnights, so a 23- or 25-hour day around a clock change still counts as one day.
    const start = dayStartMs(day, input.timeZone);
    const end = dayStartMs(nextDay(day), input.timeZone);
    const inside = Math.min(end, input.windowEnd) - Math.max(start, input.windowStart);
    weights += Math.max(0, inside) / (end - start);
  }
  return {
    budgetPercent: Math.min(100, WORKDAY_SHARE_PERCENT * weights),
    isWorkday,
    workdayWeightsSoFar: weights,
  };
}

export interface WindowReadout {
  readonly usedPercent: number;
  readonly leftPercent: number;
  readonly resetsAt: number | null;
}

/**
 * Today's pace budget; `leftPercent` is the budget's share left, negative over pace, null on a day
 * off. The budget grows at `nextStepAt`, the next workday's local midnight (null once nothing more
 * accrues), while usage only restarts when the weekly window resets at `resetsAt`.
 */
export interface DailyReadout {
  readonly usedPercent: number;
  readonly budgetPercent: number;
  readonly leftPercent: number | null;
  readonly nextStepAt: number | null;
  readonly resetsAt: number;
}

/** One account's weekly window: what it used and its clock, if it reports one. */
export interface WeeklyMember {
  readonly usedPercent: number;
  readonly span: { readonly start: number; readonly end: number } | null;
}

/** Local midnight starting the first Monday–Friday after the day `now` falls on. */
function nextWorkdayStart(now: number, timeZone: string): number {
  let day = nextDay(localDay(now, timeZone));
  while ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) day = nextDay(day);
  return dayStartMs(day, timeZone);
}

/**
 * The sidebar's per-provider readouts: the five-hour window left, today's
 * pace budget left as a share of the budget, and the weekly limit left.
 *
 * Accounts' weekly windows can open on different days, so the day is paced
 * per account and then averaged, budget and usage over the same accounts:
 * only those with a clock, since without one there is no budget. With none,
 * there is no daily readout.
 */
export function limitReadouts(input: {
  readonly session: { readonly usedPercent: number; readonly resetsAt: number | null } | null;
  readonly weekly: {
    readonly usedPercent: number;
    readonly members: readonly WeeklyMember[];
  } | null;
  readonly now: number;
  readonly timeZone: string;
}): {
  readonly session: WindowReadout | null;
  readonly daily: DailyReadout | null;
  readonly weekly: WindowReadout | null;
} {
  const { session, weekly, now, timeZone } = input;
  const timed = (weekly?.members ?? []).flatMap((member) =>
    member.span
      ? [
          {
            usedPercent: member.usedPercent,
            end: member.span.end,
            pace: dailyPaceBudget({
              windowStart: member.span.start,
              windowEnd: member.span.end,
              now,
              timeZone,
            }),
          },
        ]
      : [],
  );
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const resetsAt = timed.length > 0 ? Math.min(...timed.map((member) => member.end)) : null;
  let daily: DailyReadout | null = null;
  if (resetsAt !== null) {
    const budget = mean(timed.map((member) => member.pace.budgetPercent));
    const used = mean(timed.map((member) => member.usedPercent));
    const step = nextWorkdayStart(now, timeZone);
    daily = {
      usedPercent: Math.round(used),
      budgetPercent: Math.round(budget),
      // The day is the same local day for every account.
      leftPercent: !timed[0]!.pace.isWorkday
        ? null
        : budget > 0
          ? Math.round(((budget - used) / budget) * 100)
          : 0,
      nextStepAt: timed.some((member) => step < member.end && member.pace.budgetPercent < 100)
        ? step
        : null,
      resetsAt,
    };
  }
  return {
    session: session && { ...session, leftPercent: 100 - session.usedPercent },
    daily,
    weekly: weekly && {
      usedPercent: weekly.usedPercent,
      leftPercent: 100 - weekly.usedPercent,
      resetsAt,
    },
  };
}

/**
 * Splits a limit window's used percent across the models that ran in it.
 *
 * The provider does not say which model spent its quota, so this estimates it
 * from the transcripts the connected environments scanned: each model's share
 * of API-equivalent cost inside [startMs, nowMs], because pricier models burn
 * limits faster. A bucket with no rates is weighted by its tokens at the
 * provider's average priced cost per token, or everything falls back to tokens
 * when nothing in the window is priced. Buckets that straddle the window start
 * count by the share of their time inside it.
 *
 * The split is proportional: usage from other machines or apps on the same
 * account is invisible here, so it is spread over the models seen rather than
 * shown as its own row (there is no way to size it).
 *
 * Returns null when the provider has no usage in the window.
 */
export function attributeWindow(input: {
  readonly buckets: readonly UsageBucket[];
  readonly provider: UsageProviderKind;
  readonly startMs: number;
  readonly nowMs: number;
  readonly usedPercent: number;
  readonly timeZone: string;
}): WindowAttribution | null {
  const entries: {
    model: string;
    period: string;
    cost: number;
    tokens: number;
    priced: boolean;
  }[] = [];
  const dayStarts = new Map<string, number>();
  for (const bucket of input.buckets) {
    if (bucket.provider !== input.provider) continue;
    let start: number;
    let length: number;
    if (bucket.hourStart !== undefined) {
      start = Date.parse(bucket.hourStart);
      length = HOUR_MS;
    } else {
      start = dayStarts.get(bucket.day) ?? dayStartMs(bucket.day, input.timeZone);
      dayStarts.set(bucket.day, start);
      length = DAY_MS;
    }
    // Everything in a bucket happened before now, so a bucket still open ends at now.
    const end = Math.min(start + length, input.nowMs);
    if (!(end > start)) continue;
    // ponytail: assumes even spending within a bucket; hourly data for long windows needs a wider server window.
    const inside = Math.max(0, end - Math.max(start, input.startMs)) / (end - start);
    if (inside === 0) continue;
    const t = bucket.totals;
    const tokens =
      t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
    entries.push({
      model: bucket.model,
      period: bucket.hourStart ?? bucket.day,
      cost: bucket.costUsd * inside,
      tokens: tokens * inside,
      priced: bucket.unpricedRecords < bucket.records,
    });
  }

  let pricedCost = 0;
  let pricedTokens = 0;
  for (const entry of entries) {
    if (!entry.priced) continue;
    pricedCost += entry.cost;
    pricedTokens += entry.tokens;
  }
  const costPerToken = pricedTokens > 0 ? pricedCost / pricedTokens : 0;
  const weightOf = (entry: (typeof entries)[number]) =>
    costPerToken === 0 ? entry.tokens : entry.priced ? entry.cost : entry.tokens * costPerToken;

  const byModel = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const weight = weightOf(entry);
    byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + weight);
    total += weight;
  }
  if (total <= 0) return null;

  const ranked = [...byModel].toSorted((left, right) => right[1] - left[1]);
  const kept = ranked.length > MAX_MODELS ? ranked.slice(0, MAX_MODELS - 1) : ranked;
  const names = kept.map(([model]) => model);
  if (kept.length < ranked.length) names.push(OTHER_MODELS);
  const indexOf = (model: string) => {
    const index = names.indexOf(model);
    return index === -1 ? names.length - 1 : index;
  };
  const toPercent = (weight: number) => (weight / total) * input.usedPercent;

  const percents = names.map(() => 0);
  const tokens = names.map(() => 0);
  const periods = new Map<string, number[]>();
  for (const entry of entries) {
    const index = indexOf(entry.model);
    const points = toPercent(weightOf(entry));
    percents[index] = (percents[index] ?? 0) + points;
    tokens[index] = (tokens[index] ?? 0) + entry.tokens;
    const row = periods.get(entry.period) ?? names.map(() => 0);
    row[index] = (row[index] ?? 0) + points;
    periods.set(entry.period, row);
  }
  return {
    models: names.map((model, index) => ({
      model,
      percent: percents[index] ?? 0,
      tokens: tokens[index] ?? 0,
    })),
    periods,
  };
}

const WINDOW_KIND_LABELS = {
  session: "5 hours",
  weekly: "Weekly",
  monthly: "Monthly",
  other: null,
} satisfies Record<LimitPoolWindow["kind"], string | null>;

/**
 * The limit windows the Limits page can switch between: one per kind any
 * provider reports, shortest first. `other` has no fixed length, so it takes
 * the first such window's own label.
 */
export function limitWindowOptions(
  pools: readonly LimitPool[],
): readonly { readonly value: LimitPoolWindow["kind"]; readonly label: string }[] {
  const windows = pools.flatMap((pool) => pool.windows);
  return (Object.keys(WINDOW_KIND_LABELS) as LimitPoolWindow["kind"][]).flatMap((kind) => {
    const first = windows.find((window) => window.kind === kind);
    return first ? [{ value: kind, label: WINDOW_KIND_LABELS[kind] ?? first.label }] : [];
  });
}

/**
 * Chart bands over a set of window attributions: one per window (the sum of
 * its models), or one per model within each window. `columns` holds each
 * period's value per band, aligned to `bands`. Windows with nothing
 * attributed get no band.
 */
export function limitChartColumns(
  attributions: readonly (WindowAttribution | null)[],
  periods: readonly string[],
  by: "provider" | "model",
): {
  readonly bands: readonly { readonly row: number; readonly model: number | null }[];
  readonly columns: readonly (readonly number[])[];
} {
  const bands = attributions.flatMap((attribution, row): { row: number; model: number | null }[] =>
    attribution === null
      ? []
      : by === "provider"
        ? [{ row, model: null }]
        : attribution.models.map((_, model) => ({ row, model })),
  );
  const columns = periods.map((period) =>
    bands.map(({ row, model }) => {
      const values = attributions[row]?.periods.get(period) ?? [];
      return model === null ? values.reduce((sum, value) => sum + value, 0) : (values[model] ?? 0);
    }),
  );
  return { bands, columns };
}
