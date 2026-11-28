import {
  NonNegativeInt,
  type UsageBucket,
  type UsageCostSource,
  type UsageLimitSourceSnapshots,
  type UsageProviderKind,
  type UsageSummary,
  UsageProviderKind as UsageProviderKindSchema,
} from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const MAX_USAGE_DAYS = 31;
const DEFAULT_USAGE_DAYS = 7;
const MAX_USAGE_MODELS = 25;
export const MAX_THREAD_CANDIDATES = 200;
export const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 50;
/** Fill at or above this, against auto-compaction or the context window, is "near". */
const NEAR_COMPACTION_FILL = 0.8;
const TITLE_CHARS = 120;
const HOUR_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const Rate = Schema.NullOr(Schema.Number);
const TokenBreakdown = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});

const SummaryGroup = Schema.Struct({
  tokens: TokenBreakdown,
  cacheHitRate: Rate,
  costUsd: Schema.Number,
  costPerMillionUsd: Rate,
});

export const UsageSummaryReport = Schema.Struct({
  readAt: Schema.String,
  timeZone: Schema.String,
  sinceDay: Schema.String,
  untilDay: Schema.String,
  refreshing: Schema.Boolean,
  pricing: Schema.Struct({
    status: Schema.String,
    knownModels: NonNegativeInt,
  }),
  totals: Schema.Struct({
    tokens: TokenBreakdown,
    cacheHitRate: Rate,
    costUsd: Schema.Number,
    cacheSavingsUsd: Schema.Number,
    costPerMillionUsd: Rate,
    unpricedTokens: NonNegativeInt,
    records: NonNegativeInt,
    sessions: NonNegativeInt,
    categoryCostUsd: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        cacheRead: Schema.Number,
        cacheWrite: Schema.Number,
        output: Schema.Number,
        other: Schema.Number,
      }),
    ),
    speedCostUsd: Schema.optional(
      Schema.Struct({
        standard: Schema.Number,
        fast: Schema.Number,
        ultrafast: Schema.Number,
        premium: Schema.Number,
      }),
    ),
    costQuality: Schema.Struct({
      providerReportedShare: Schema.Number,
      modelPricedShare: Schema.Number,
      unpricedShare: Schema.Number,
    }),
  }),
  byProvider: Schema.Array(
    Schema.Struct({
      provider: UsageProviderKindSchema,
      ...SummaryGroup.fields,
      records: NonNegativeInt,
    }),
  ),
  byModel: Schema.Array(
    Schema.Struct({
      provider: UsageProviderKindSchema,
      model: Schema.String,
      ...SummaryGroup.fields,
      unpriced: Schema.Boolean,
      records: NonNegativeInt,
    }),
  ),
  omittedModels: NonNegativeInt,
  byDay: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      totalTokens: NonNegativeInt,
      costUsd: Schema.Number,
      cacheHitRate: Rate,
    }),
  ),
  byHour: Schema.optional(
    Schema.Array(
      Schema.Struct({
        hourStart: Schema.String,
        totalTokens: NonNegativeInt,
        costUsd: Schema.Number,
        cacheHitRate: Rate,
      }),
    ),
  ),
  sources: Schema.Array(
    Schema.Struct({
      provider: UsageProviderKindSchema,
      status: Schema.String,
      sessions: NonNegativeInt,
      refreshing: Schema.optional(Schema.Literal(true)),
    }),
  ),
  notes: Schema.Array(Schema.String),
});
export type UsageSummaryReport = typeof UsageSummaryReport.Type;

const ThreadTokens = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  otherTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  cacheHitRate: Rate,
  turns: NonNegativeInt,
  partialTurns: NonNegativeInt,
});

const ThreadIdentity = {
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  subagent: Schema.Boolean,
  model: Schema.optional(Schema.String),
  serviceTier: Schema.optional(Schema.String),
};

export const UsageThreadsReport = Schema.Struct({
  readAt: Schema.String,
  timeZone: Schema.String,
  sinceDay: Schema.String,
  untilDay: Schema.String,
  since: Schema.String,
  until: Schema.String,
  candidates: NonNegativeInt,
  truncated: Schema.Boolean,
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
      threads: NonNegativeInt,
      ...ThreadTokens.fields,
    }),
  ),
  threads: Schema.Array(Schema.Struct({ ...ThreadIdentity, ...ThreadTokens.fields })),
  nearAutoCompaction: Schema.Array(
    Schema.Struct({
      ...ThreadIdentity,
      usedTokens: NonNegativeInt,
      maxTokens: Schema.optional(NonNegativeInt),
      autoCompactThreshold: Schema.optional(NonNegativeInt),
      fillRatio: Schema.Number,
      usageUpdatedAt: Schema.optional(Schema.String),
    }),
  ),
  highestContextFill: Schema.optional(
    Schema.Struct({
      ...ThreadIdentity,
      usedTokens: NonNegativeInt,
      maxTokens: Schema.optional(NonNegativeInt),
      autoCompactThreshold: Schema.optional(NonNegativeInt),
      fillRatio: Schema.Number,
      usageUpdatedAt: Schema.optional(Schema.String),
    }),
  ),
  notes: Schema.Array(Schema.String),
});
export type UsageThreadsReport = typeof UsageThreadsReport.Type;

const LimitWindow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
  modelIds: Schema.optional(Schema.Array(Schema.String)),
  modelIdsTruncated: Schema.optional(Schema.Literal(true)),
});

export const UsageLimitsReport = Schema.Struct({
  readAt: Schema.String,
  accounts: Schema.Array(
    Schema.Struct({
      sourceKind: Schema.Literals(["provider", "hub", "http"]),
      source: Schema.optional(Schema.String),
      driver: Schema.optional(Schema.String),
      instanceId: Schema.optional(Schema.String),
      label: Schema.String,
      plan: Schema.optional(Schema.String),
      checkedAt: Schema.optional(Schema.String),
      unreadable: Schema.optional(Schema.Literal(true)),
      zeroSpendCap: Schema.optional(Schema.Literal(true)),
      windows: Schema.Array(LimitWindow),
      resetCredits: Schema.optional(
        Schema.Struct({
          availableCount: NonNegativeInt,
          nextExpiresAt: Schema.optional(Schema.String),
        }),
      ),
      unavailable: Schema.optional(
        Schema.Struct({
          reason: Schema.String,
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  notes: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;

const SUMMARY_NOTES = [
  "Estimated API-equivalent cost, not the subscription bill. Reasoning tokens are included in output.",
  "Cache hit rate is cached input divided by uncached input, cache reads, and cache writes.",
  "Fast and Ultrafast premiums match the last Usage scan. This read does not query turn history to classify Codex speed.",
  "Session counts can include the same session more than once across providers.",
];

const THREAD_NOTES = [
  "Turn inputTokens include cache reads and writes. totalTokens adds output and otherTokens (native subagents and compaction). Reasoning is already included in output.",
  "Totals cover the newest active threads updated in this window, not every thread, and not provider history outside T3. t3_usage_summary is the environment-wide cost.",
  "Archived threads are omitted unless threadId is set. Message text is not included.",
];

const LIMIT_NOTES = [
  "Cached snapshot from the last provider check. This read did not probe providers or redeem reset credits.",
  "A hub and a local login for the same account can both appear. Emails, credentials, and credit ids are omitted.",
];

export type UsageWindow =
  | {
      readonly ok: true;
      readonly sinceDay: string;
      readonly untilDay: string;
      readonly timeZone: string;
      readonly sinceIso: string;
      readonly untilIso: string;
    }
  | { readonly ok: false; readonly detail: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function shiftDay(day: string, days: number): string {
  if (!validDay(day)) return day;
  return DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00.000Z`), { days }),
  );
}

function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = DateTime.make(`${day}T00:00:00.000Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDateUtc(parsed.value) === day;
}

function dayInTimeZone(nowMs: number, timeZone: string): string {
  return DateTime.formatIsoDate(DateTime.makeZonedUnsafe(nowMs, { timeZone }));
}

/** UTC instant of local midnight on `day` in `timeZone`, as an ISO string with milliseconds. */
export function zonedDayStartIso(day: string, timeZone: string): string {
  return DateTime.formatIso(
    DateTime.makeZonedUnsafe(`${day}T00:00:00`, { timeZone, adjustForTimeZone: true }),
  );
}

export function resolveUsageWindow(input: {
  readonly sinceDay?: string | undefined;
  readonly untilDay?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly nowMs: number;
}): UsageWindow {
  const timeZone = input.timeZone?.trim() || "UTC";
  if (Option.isNone(DateTime.zoneMakeNamed(timeZone))) {
    return { ok: false, detail: `timeZone '${timeZone}' is not a valid IANA time zone.` };
  }
  const sinceGiven = input.sinceDay !== undefined;
  const untilGiven = input.untilDay !== undefined;
  if (sinceGiven !== untilGiven) {
    return {
      ok: false,
      detail: "Pass sinceDay and untilDay together, or omit both for the last 7 days.",
    };
  }
  const untilDay = input.untilDay ?? dayInTimeZone(input.nowMs, timeZone);
  const sinceDay = input.sinceDay ?? shiftDay(untilDay, -(DEFAULT_USAGE_DAYS - 1));
  if (!validDay(sinceDay) || !validDay(untilDay)) {
    return { ok: false, detail: "sinceDay and untilDay must be calendar dates, YYYY-MM-DD." };
  }
  if (sinceDay > untilDay) {
    return { ok: false, detail: `sinceDay '${sinceDay}' is after untilDay '${untilDay}'.` };
  }
  const span =
    Math.round(
      (Date.parse(`${untilDay}T00:00:00Z`) - Date.parse(`${sinceDay}T00:00:00Z`)) / DAY_MS,
    ) + 1;
  if (span > MAX_USAGE_DAYS) {
    return { ok: false, detail: `Date range is ${span} days. The maximum is ${MAX_USAGE_DAYS}.` };
  }
  return {
    ok: true,
    sinceDay,
    untilDay,
    timeZone,
    sinceIso: zonedDayStartIso(sinceDay, timeZone),
    untilIso: zonedDayStartIso(shiftDay(untilDay, 1), timeZone),
  };
}

export function resolveHourlyBounds(input: {
  readonly resolution?: "day" | "hour" | undefined;
  readonly sinceTime?: string | undefined;
  readonly untilTime?: string | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (input.resolution !== "hour") return { ok: true };
  if (input.sinceTime === undefined || input.untilTime === undefined) {
    return { ok: false, detail: "Hourly usage requires sinceTime and untilTime." };
  }
  const sinceMs = Date.parse(input.sinceTime);
  const untilMs = Date.parse(input.untilTime);
  const duration = untilMs - sinceMs;
  if (!Number.isFinite(duration) || duration <= 0 || duration > HOUR_MS) {
    return {
      ok: false,
      detail: "Hourly usage window must be greater than zero and at most 24 hours.",
    };
  }
  return { ok: true };
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const usd = (value: number) => round(value, 6);
const share = (value: number) => round(value, 4);

interface Totals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  unpricedTokens: number;
  providerReportedRecords: number;
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  sawCategory: boolean;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  sawSpeed: boolean;
}

function emptyTotals(): Totals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    records: 0,
    unpricedRecords: 0,
    unpricedTokens: 0,
    providerReportedRecords: 0,
    inputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    outputCost: 0,
    sawCategory: false,
    fastCostUsd: 0,
    ultrafastCostUsd: 0,
    speedPremiumUsd: 0,
    sawSpeed: false,
  };
}

function tokenTotal(bucket: UsageBucket["totals"]): number {
  return (
    bucket.uncachedInputTokens +
    bucket.cachedInputTokens +
    bucket.cacheCreationTokens +
    bucket.outputTokens
  );
}

function addBucket(totals: Totals, bucket: UsageBucket) {
  const tokens = bucket.totals;
  const total = tokenTotal(tokens);
  totals.uncachedInputTokens += tokens.uncachedInputTokens;
  totals.cachedInputTokens += tokens.cachedInputTokens;
  totals.cacheCreationTokens += tokens.cacheCreationTokens;
  totals.outputTokens += tokens.outputTokens;
  totals.reasoningTokens += tokens.reasoningTokens;
  totals.costUsd += bucket.costUsd;
  totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
  totals.records += bucket.records;
  totals.unpricedRecords += bucket.unpricedRecords;
  totals.unpricedTokens +=
    bucket.unpricedTokens ??
    (bucket.records === 0 ? 0 : Math.round((total * bucket.unpricedRecords) / bucket.records));
  if (bucket.costSource === ("providerReported" satisfies UsageCostSource)) {
    totals.providerReportedRecords += bucket.records;
  }
  if (bucket.categoryCostUsd !== undefined) {
    totals.sawCategory = true;
    totals.inputCost += bucket.categoryCostUsd.input;
    totals.cacheReadCost += bucket.categoryCostUsd.cacheRead;
    totals.cacheWriteCost += bucket.categoryCostUsd.cacheWrite;
    totals.outputCost += bucket.categoryCostUsd.output;
  }
  if (
    bucket.fastCostUsd !== undefined ||
    bucket.ultrafastCostUsd !== undefined ||
    bucket.speedPremiumUsd !== undefined
  ) {
    totals.sawSpeed = true;
    totals.fastCostUsd += bucket.fastCostUsd ?? 0;
    totals.ultrafastCostUsd += bucket.ultrafastCostUsd ?? 0;
    totals.speedPremiumUsd += bucket.speedPremiumUsd ?? 0;
  }
}

function totalTokens(totals: Totals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

function cacheHitRate(totals: Totals): number | null {
  const input = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  return input === 0 ? null : share(totals.cachedInputTokens / input);
}

function costPerMillion(totals: Totals): number | null {
  const priced = totalTokens(totals) - totals.unpricedTokens;
  const unknown = totals.records > 0 && totals.unpricedRecords >= totals.records;
  return priced <= 0 || unknown ? null : share((totals.costUsd / priced) * 1_000_000);
}

function tokensOf(totals: Totals) {
  return {
    uncachedInputTokens: totals.uncachedInputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totalTokens(totals),
  };
}

function groupOf(totals: Totals) {
  return {
    tokens: tokensOf(totals),
    cacheHitRate: cacheHitRate(totals),
    costUsd: usd(totals.costUsd),
    costPerMillionUsd: costPerMillion(totals),
  };
}

export function compactUsageSummary(summary: UsageSummary): UsageSummaryReport {
  const overall = emptyTotals();
  const byProvider = new Map<UsageProviderKind, Totals>();
  const byModel = new Map<string, { provider: UsageProviderKind; model: string; totals: Totals }>();
  const byDay = new Map<string, Totals>();
  const byHour = new Map<string, Totals>();
  for (const bucket of summary.buckets) {
    addBucket(overall, bucket);
    const provider = byProvider.get(bucket.provider) ?? emptyTotals();
    addBucket(provider, bucket);
    byProvider.set(bucket.provider, provider);
    const modelKey = `${bucket.provider}\0${bucket.model}`;
    const model = byModel.get(modelKey) ?? {
      provider: bucket.provider,
      model: bucket.model,
      totals: emptyTotals(),
    };
    addBucket(model.totals, bucket);
    byModel.set(modelKey, model);
    const day = byDay.get(bucket.day) ?? emptyTotals();
    addBucket(day, bucket);
    byDay.set(bucket.day, day);
    if (bucket.hourStart !== undefined) {
      const hour = byHour.get(bucket.hourStart) ?? emptyTotals();
      addBucket(hour, bucket);
      byHour.set(bucket.hourStart, hour);
    }
  }
  const models = [...byModel.values()]
    .sort(
      (left, right) =>
        totalTokens(right.totals) - totalTokens(left.totals) ||
        right.totals.costUsd - left.totals.costUsd,
    )
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      ...groupOf(entry.totals),
      unpriced: entry.totals.records > 0 && entry.totals.unpricedRecords >= entry.totals.records,
      records: entry.totals.records,
    }));
  const records = overall.records;
  const shareOf = (count: number) => (records === 0 ? 0 : share(count / records));
  const hours = [...byHour.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return {
    readAt: summary.readAt,
    timeZone: summary.timeZone,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    refreshing: summary.sources.some((source) => source.refreshing === true),
    pricing: { status: summary.pricing.status, knownModels: summary.pricing.knownModels },
    totals: {
      ...groupOf(overall),
      cacheSavingsUsd: usd(overall.cacheSavingsUsd),
      unpricedTokens: overall.unpricedTokens,
      records,
      sessions: summary.sources.reduce((sum, source) => sum + source.distinctSessions, 0),
      ...(overall.sawCategory
        ? {
            categoryCostUsd: {
              input: usd(overall.inputCost),
              cacheRead: usd(overall.cacheReadCost),
              cacheWrite: usd(overall.cacheWriteCost),
              output: usd(overall.outputCost),
              other: usd(
                Math.max(
                  0,
                  overall.costUsd -
                    overall.inputCost -
                    overall.cacheReadCost -
                    overall.cacheWriteCost -
                    overall.outputCost,
                ),
              ),
            },
          }
        : {}),
      ...(overall.sawSpeed
        ? {
            speedCostUsd: {
              standard: usd(
                Math.max(0, overall.costUsd - overall.fastCostUsd - overall.ultrafastCostUsd),
              ),
              fast: usd(overall.fastCostUsd),
              ultrafast: usd(overall.ultrafastCostUsd),
              premium: usd(overall.speedPremiumUsd),
            },
          }
        : {}),
      costQuality: {
        providerReportedShare: shareOf(overall.providerReportedRecords),
        unpricedShare: shareOf(overall.unpricedRecords),
        modelPricedShare: shareOf(
          Math.max(0, records - overall.providerReportedRecords - overall.unpricedRecords),
        ),
      },
    },
    byProvider: [...byProvider.entries()]
      .sort(
        ([, left], [, right]) =>
          totalTokens(right) - totalTokens(left) || right.costUsd - left.costUsd,
      )
      .map(([provider, totals]) => ({ provider, ...groupOf(totals), records: totals.records })),
    byModel: models.slice(0, MAX_USAGE_MODELS),
    omittedModels: Math.max(0, models.length - MAX_USAGE_MODELS),
    byDay: [...byDay.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([day, totals]) => ({
        day,
        totalTokens: totalTokens(totals),
        costUsd: usd(totals.costUsd),
        cacheHitRate: cacheHitRate(totals),
      })),
    ...(hours.length === 0
      ? {}
      : {
          byHour: hours.map(([hourStart, totals]) => ({
            hourStart,
            totalTokens: totalTokens(totals),
            costUsd: usd(totals.costUsd),
            cacheHitRate: cacheHitRate(totals),
          })),
        }),
    sources: summary.sources.map((source) => ({
      provider: source.fingerprint.provider,
      status: source.status,
      sessions: source.distinctSessions,
      ...(source.refreshing === true ? { refreshing: true as const } : {}),
    })),
    notes: SUMMARY_NOTES,
  };
}

function shortTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= TITLE_CHARS ? title : `${chars.slice(0, TITLE_CHARS - 1).join("")}…`;
}

export interface ThreadCandidateRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly subagent: boolean;
}

export interface ThreadTurnRow {
  readonly threadId: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly otherTokens: number;
  readonly partialTurns: number;
  readonly turns: number;
  readonly model?: string | undefined;
  readonly serviceTier?: string | undefined;
}

export interface ThreadContextRow {
  readonly threadId: string;
  readonly usedTokens?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly autoCompactThreshold?: number | undefined;
  readonly usageUpdatedAt?: string | undefined;
  readonly model?: string | undefined;
  readonly serviceTier?: string | undefined;
}

function turnCacheHit(inputTokens: number, cachedInputTokens: number): number | null {
  return inputTokens === 0 ? null : share(cachedInputTokens / inputTokens);
}

function turnTotal(row: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly otherTokens: number;
}): number {
  return row.inputTokens + row.outputTokens + row.otherTokens;
}

function presentTurn(row: {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly otherTokens: number;
  readonly partialTurns: number;
  readonly turns: number;
}) {
  return {
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    otherTokens: row.otherTokens,
    totalTokens: turnTotal(row),
    cacheHitRate: turnCacheHit(row.inputTokens, row.cachedInputTokens),
    turns: row.turns,
    partialTurns: row.partialTurns,
  };
}

function optionalText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { model: trimmed };
}

function tier(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { serviceTier: trimmed };
}

export function compactThreadActivity(input: {
  readonly readAt: string;
  readonly window: Extract<UsageWindow, { ok: true }>;
  readonly limit: number;
  readonly truncated: boolean;
  readonly candidates: readonly ThreadCandidateRow[];
  readonly turns: readonly ThreadTurnRow[];
  readonly context: readonly ThreadContextRow[];
  readonly projectTitles: ReadonlyMap<string, string>;
}): UsageThreadsReport {
  const limit = Math.min(MAX_THREAD_LIMIT, Math.max(1, input.limit));
  const candidates = new Map(input.candidates.map((candidate) => [candidate.threadId, candidate]));
  const titleOf = (projectId: string) =>
    shortTitle(input.projectTitles.get(projectId) ?? projectId);
  const identity = (candidate: ThreadCandidateRow, model?: string, serviceTier?: string) => ({
    threadId: candidate.threadId,
    title: shortTitle(candidate.title),
    projectId: candidate.projectId,
    projectTitle: titleOf(candidate.projectId),
    subagent: candidate.subagent,
    ...optionalText(model),
    ...tier(serviceTier),
  });
  const turns = input.turns
    .flatMap((row) => {
      const candidate = candidates.get(row.threadId);
      return candidate === undefined ? [] : [{ row, candidate }];
    })
    .sort(
      (left, right) =>
        turnTotal(right.row) - turnTotal(left.row) ||
        left.candidate.title.localeCompare(right.candidate.title),
    );
  const projects = new Map<
    string,
    {
      title: string;
      threads: number;
      inputTokens: number;
      cachedInputTokens: number;
      cacheCreationTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      otherTokens: number;
      partialTurns: number;
      turns: number;
    }
  >();
  for (const { row, candidate } of turns) {
    const current = projects.get(candidate.projectId);
    if (current === undefined) {
      projects.set(candidate.projectId, {
        title: titleOf(candidate.projectId),
        threads: 1,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        otherTokens: row.otherTokens,
        partialTurns: row.partialTurns,
        turns: row.turns,
      });
      continue;
    }
    current.inputTokens += row.inputTokens;
    current.cachedInputTokens += row.cachedInputTokens;
    current.cacheCreationTokens += row.cacheCreationTokens;
    current.outputTokens += row.outputTokens;
    current.reasoningTokens += row.reasoningTokens;
    current.otherTokens += row.otherTokens;
    current.partialTurns += row.partialTurns;
    current.turns += row.turns;
    current.threads += 1;
  }
  const projectRows = [...projects.entries()]
    .map(([projectId, row]) => ({
      projectId,
      title: row.title,
      threads: row.threads,
      ...presentTurn(row),
    }))
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens || left.title.localeCompare(right.title),
    );
  const context = input.context.flatMap((row) => {
    const candidate = candidates.get(row.threadId);
    const denominator = row.autoCompactThreshold ?? row.maxTokens;
    if (
      candidate === undefined ||
      row.usedTokens === undefined ||
      denominator === undefined ||
      denominator <= 0
    ) {
      return [];
    }
    return [
      {
        ...identity(candidate, row.model, row.serviceTier),
        usedTokens: row.usedTokens,
        ...(row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens }),
        ...(row.autoCompactThreshold === undefined
          ? {}
          : { autoCompactThreshold: row.autoCompactThreshold }),
        fillRatio: share(row.usedTokens / denominator),
        ...(row.usageUpdatedAt === undefined ? {} : { usageUpdatedAt: row.usageUpdatedAt }),
      },
    ];
  });
  context.sort(
    (left, right) => right.fillRatio - left.fillRatio || left.title.localeCompare(right.title),
  );
  const near = context.filter((row) => row.fillRatio >= NEAR_COMPACTION_FILL).slice(0, limit);
  const highest = context[0];
  return {
    readAt: input.readAt,
    timeZone: input.window.timeZone,
    sinceDay: input.window.sinceDay,
    untilDay: input.window.untilDay,
    since: input.window.sinceIso,
    until: input.window.untilIso,
    candidates: input.candidates.length,
    truncated: input.truncated,
    projects: projectRows.slice(0, limit),
    threads: turns.slice(0, limit).map(({ row, candidate }) => ({
      ...identity(candidate, row.model, row.serviceTier),
      ...presentTurn(row),
    })),
    nearAutoCompaction: near,
    ...(highest === undefined || near.includes(highest) ? {} : { highestContextFill: highest }),
    notes: input.truncated
      ? [...THREAD_NOTES, "More threads were updated in this window than this read includes."]
      : THREAD_NOTES,
  };
}

const KIND_ORDER: Record<string, number> = { session: 0, weekly: 1, monthly: 2, other: 3 };
const MODEL_ID_CAP = 8;

function limitWindows(
  windows: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt?: string | undefined;
    readonly modelIds?: ReadonlyArray<string> | undefined;
  }>,
) {
  return windows
    .map((window, index) => ({ window, index }))
    .sort(
      (left, right) =>
        (KIND_ORDER[left.window.kind] ?? 9) - (KIND_ORDER[right.window.kind] ?? 9) ||
        left.index - right.index,
    )
    .map(({ window }) => {
      const modelIds = window.modelIds?.slice(0, MODEL_ID_CAP);
      return {
        id: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: round(window.usedPercent, 1),
        remainingPercent: round(Math.max(0, 100 - window.usedPercent), 1),
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(modelIds === undefined || modelIds.length === 0 ? {} : { modelIds: [...modelIds] }),
        ...(window.modelIds !== undefined && window.modelIds.length > MODEL_ID_CAP
          ? { modelIdsTruncated: true as const }
          : {}),
      };
    });
}

function credits(
  input:
    | { readonly availableCount: number; readonly nextExpiresAt?: string | undefined }
    | undefined,
) {
  if (input === undefined) return {};
  return {
    resetCredits: {
      availableCount: input.availableCount,
      ...(input.nextExpiresAt === undefined ? {} : { nextExpiresAt: input.nextExpiresAt }),
    },
  };
}

function unavailable(
  input: { readonly reason: string; readonly message?: string | undefined } | undefined,
) {
  if (input === undefined) return {};
  const message = input.message?.trim();
  return {
    unavailable: {
      reason: input.reason,
      ...(message === undefined || message.length === 0
        ? {}
        : { message: Array.from(message).slice(0, 160).join("") }),
    },
  };
}

export function compactUsageLimits(input: {
  readonly readAt: string;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "usageLimits">
  >;
  readonly sources: UsageLimitSourceSnapshots;
}): UsageLimitsReport {
  const accounts: UsageLimitsReport["accounts"][number][] = [];
  for (const provider of input.providers) {
    const limits = provider.usageLimits;
    if (limits === undefined) continue;
    accounts.push({
      sourceKind: "provider",
      driver: provider.driver,
      instanceId: provider.instanceId,
      label: provider.displayName?.trim() || provider.driver,
      checkedAt: limits.checkedAt,
      ...(limits.zeroSpendCap === true ? { zeroSpendCap: true as const } : {}),
      windows: limitWindows(limits.windows),
      ...credits(limits.resetCredits),
      ...unavailable(limits.unavailable),
    });
  }
  for (const source of input.sources) {
    if (
      source.accounts.length === 0 &&
      source.quotaAccounts === undefined &&
      source.error !== undefined
    ) {
      accounts.push({
        sourceKind: source.kind === "http" ? "http" : "hub",
        source: source.label,
        label: source.label,
        checkedAt: source.checkedAt,
        unreadable: true,
        windows: [],
      });
    }
    for (const account of source.accounts) {
      const limits = account.usageLimits;
      accounts.push({
        sourceKind: "hub",
        source: source.label,
        driver: account.driver,
        label: account.plan?.trim() || account.driver,
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        checkedAt: limits.checkedAt,
        ...(limits.zeroSpendCap === true ? { zeroSpendCap: true as const } : {}),
        windows: limitWindows(limits.windows),
        ...credits(limits.resetCredits),
        ...unavailable(limits.unavailable),
      });
    }
    for (const account of source.quotaAccounts ?? []) {
      accounts.push({
        sourceKind: "http",
        source: source.label,
        ...(account.providerInstanceId === undefined
          ? {}
          : { instanceId: account.providerInstanceId }),
        label: account.label,
        checkedAt: source.checkedAt,
        windows: limitWindows(account.windows),
      });
    }
  }
  accounts.sort(
    (left, right) =>
      (left.driver ?? "").localeCompare(right.driver ?? "") ||
      left.label.localeCompare(right.label),
  );
  return { readAt: input.readAt, accounts, notes: LIMIT_NOTES };
}
