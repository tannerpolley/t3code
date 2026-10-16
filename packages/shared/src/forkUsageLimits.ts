import type { ServerProviderUsageWindow, UsageBucket, UsageProviderKind } from "@t3tools/contracts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A passed reset says nothing about the new allowance until the provider reads it again. */
export function isUsageWindowStale(window: ServerProviderUsageWindow, now: number): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now;
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

export interface LimitWindowEntry {
  readonly model: string;
  /** The bucket's `hourStart` or `day`. */
  readonly period: string;
  /** Dollars when `priced`, else tokens. */
  readonly weight: number;
  readonly tokens: number;
}

/**
 * How much of a provider's limit window each scanned bucket spent, by API-equivalent cost, because
 * pricier models burn limits faster. A bucket with no rates is weighted by its tokens at the
 * provider's average priced cost per token. When nothing in the window is priced every weight is
 * tokens and `priced` is false. Buckets that straddle the window start count by the share of
 * their time inside it.
 */
export function weighLimitWindow(input: {
  readonly buckets: readonly UsageBucket[];
  readonly provider: UsageProviderKind;
  readonly startMs: number;
  readonly nowMs: number;
  readonly timeZone: string;
}): {
  readonly entries: readonly LimitWindowEntry[];
  readonly total: number;
  readonly priced: boolean;
} {
  const raw: { model: string; period: string; cost: number; tokens: number; priced: boolean }[] =
    [];
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
    raw.push({
      model: bucket.model,
      period: bucket.hourStart ?? bucket.day,
      cost: bucket.costUsd * inside,
      tokens: tokens * inside,
      priced: bucket.unpricedRecords < bucket.records,
    });
  }

  let pricedCost = 0;
  let pricedTokens = 0;
  for (const entry of raw) {
    if (!entry.priced) continue;
    pricedCost += entry.cost;
    pricedTokens += entry.tokens;
  }
  const costPerToken = pricedTokens > 0 ? pricedCost / pricedTokens : 0;
  let total = 0;
  const entries = raw.map(({ model, period, cost, tokens, priced }) => {
    const weight = costPerToken === 0 ? tokens : priced ? cost : tokens * costPerToken;
    total += weight;
    return { model, period, weight, tokens };
  });
  return { entries, total, priced: costPerToken > 0 };
}
