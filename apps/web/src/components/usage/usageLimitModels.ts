import type { UsageBucket, UsageProviderKind } from "@t3tools/contracts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Models past this many fold into one "Other models" row so the legend stays readable. */
const MAX_MODELS = 5;
export const OTHER_MODELS = "Other models";

export interface WindowModelShare {
  readonly model: string;
  /** Estimated points of the limit this model used, 0..usedPercent. */
  readonly percent: number;
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
  const periods = new Map<string, number[]>();
  for (const entry of entries) {
    const index = indexOf(entry.model);
    const points = toPercent(weightOf(entry));
    percents[index] = (percents[index] ?? 0) + points;
    const row = periods.get(entry.period) ?? names.map(() => 0);
    row[index] = (row[index] ?? 0) + points;
    periods.set(entry.period, row);
  }
  return {
    models: names.map((model, index) => ({ model, percent: percents[index] ?? 0 })),
    periods,
  };
}
