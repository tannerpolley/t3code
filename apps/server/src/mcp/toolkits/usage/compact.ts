import {
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { roundTo, type UsageWindow } from "./window.ts";

const UsageWindowResult = Schema.Struct({
  sinceDay: Schema.String,
  untilDay: Schema.String,
  timeZone: Schema.String,
  days: Schema.Int,
});

const TokenSplit = Schema.Struct({
  uncachedInput: Schema.Int,
  cachedInput: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  total: Schema.Int,
});

const Rate = Schema.NullOr(Schema.Number);

const ProviderRow = Schema.Struct({
  provider: Schema.String,
  tokens: TokenSplit,
  cacheHitRate: Rate,
  costUsd: Schema.Number,
  costPerMillionTokens: Rate,
  records: Schema.Int,
  unpricedTokens: Schema.Int,
  tokenShare: Schema.Number,
  costShare: Schema.Number,
});

const ModelRow = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  tokens: TokenSplit,
  cacheHitRate: Rate,
  costUsd: Schema.Number,
  costPerMillionTokens: Rate,
  records: Schema.Int,
  unpricedRecords: Schema.Int,
  unpricedTokens: Schema.Int,
  tokenShare: Schema.Number,
  costShare: Schema.Number,
});

const UsageSummaryReady = Schema.Struct({
  status: Schema.Literal("ready"),
  window: UsageWindowResult,
  readAt: Schema.String,
  refreshing: Schema.Boolean,
  pricing: Schema.Struct({
    status: Schema.Literals(["fresh", "cached", "unavailable"]),
    knownModels: Schema.Int,
  }),
  totals: Schema.Struct({
    tokens: TokenSplit,
    cacheHitRate: Rate,
    costUsd: Schema.Number,
    cacheSavingsUsd: Schema.Number,
    costPerMillionTokens: Rate,
    categoryCostUsd: Schema.Struct({
      input: Schema.Number,
      cacheRead: Schema.Number,
      cacheWrite: Schema.Number,
      output: Schema.Number,
      other: Schema.Number,
    }),
    speedUsd: Schema.Struct({
      standard: Schema.Number,
      fast: Schema.Number,
      ultrafast: Schema.Number,
      premium: Schema.Number,
    }),
    records: Schema.Int,
    sessions: Rate,
    unpricedTokens: Schema.Int,
    costSourceShare: Schema.Struct({
      modelPriced: Schema.Number,
      providerReported: Schema.Number,
      unpriced: Schema.Number,
    }),
  }),
  byProvider: Schema.Array(ProviderRow),
  byModel: Schema.Array(ModelRow),
  byDay: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      tokens: Schema.Int,
      costUsd: Schema.Number,
    }),
  ),
  sources: Schema.Struct({
    ok: Schema.Int,
    partial: Schema.Int,
    missing: Schema.Int,
    failed: Schema.Int,
    refreshing: Schema.Int,
  }),
  notices: Schema.Array(Schema.String),
});

const UsageSummaryNotCached = Schema.Struct({
  status: Schema.Literal("not_cached"),
  window: UsageWindowResult,
  message: Schema.String,
});

export const UsageSummaryResult = Schema.Union([UsageSummaryNotCached, UsageSummaryReady]);
export type UsageSummaryResult = typeof UsageSummaryResult.Type;
export type UsageSummaryReadyResult = typeof UsageSummaryReady.Type;

const LimitWindow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
  windowDurationMins: Schema.optional(Schema.Int),
  modelIds: Schema.optional(Schema.Array(Schema.String)),
});

const LimitAccount = Schema.Struct({
  provider: Schema.String,
  instanceId: Schema.optional(Schema.String),
  label: Schema.String,
  plan: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  source: Schema.Literals(["provider", "hub", "http"]),
  sourceLabel: Schema.optional(Schema.String),
  checkedAt: Schema.String,
  zeroSpendCap: Schema.optional(Schema.Literal(true)),
  windows: Schema.Array(LimitWindow),
  resetCredits: Schema.optional(
    Schema.Struct({
      availableCount: Schema.Int,
      nextExpiresAt: Schema.optional(Schema.String),
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            label: Schema.String,
            availableCount: Schema.Int,
            expiresAt: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
    }),
  ),
});

export const UsageLimitsResult = Schema.Struct({
  snapshot: Schema.Literal("cached"),
  note: Schema.String,
  accounts: Schema.Array(LimitAccount),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsResult = typeof UsageLimitsResult.Type;

const money = (value: number) => roundTo(value, 6);
const share = (value: number) => roundTo(value, 4);

interface Totals {
  uncachedInput: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  unpricedTokens: number;
  providerReportedRecords: number;
  category: { input: number; cacheRead: number; cacheWrite: number; output: number };
  fast: number;
  ultrafast: number;
  premium: number;
}

const emptyTotals = (): Totals => ({
  uncachedInput: 0,
  cachedInput: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  costUsd: 0,
  cacheSavingsUsd: 0,
  records: 0,
  unpricedRecords: 0,
  unpricedTokens: 0,
  providerReportedRecords: 0,
  category: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  fast: 0,
  ultrafast: 0,
  premium: 0,
});

function addBucket(totals: Totals, bucket: UsageBucket) {
  const tokens = bucketTokenCount(bucket);
  totals.uncachedInput += bucket.totals.uncachedInputTokens;
  totals.cachedInput += bucket.totals.cachedInputTokens;
  totals.cacheWrite += bucket.totals.cacheCreationTokens;
  totals.output += bucket.totals.outputTokens;
  totals.reasoning += bucket.totals.reasoningTokens;
  totals.costUsd += bucket.costUsd;
  totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
  totals.records += bucket.records;
  totals.unpricedRecords += bucket.unpricedRecords;
  if (bucket.unpricedTokens !== undefined) totals.unpricedTokens += bucket.unpricedTokens;
  else if (bucket.records > 0) {
    totals.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
  }
  if (bucket.costSource === "providerReported") totals.providerReportedRecords += bucket.records;
  if (bucket.categoryCostUsd !== undefined) {
    totals.category.input += bucket.categoryCostUsd.input;
    totals.category.cacheRead += bucket.categoryCostUsd.cacheRead;
    totals.category.cacheWrite += bucket.categoryCostUsd.cacheWrite;
    totals.category.output += bucket.categoryCostUsd.output;
  }
  totals.fast += bucket.fastCostUsd ?? 0;
  totals.ultrafast += bucket.ultrafastCostUsd ?? 0;
  totals.premium += bucket.speedPremiumUsd ?? 0;
}

function bucketTokenCount(bucket: UsageBucket): number {
  const { totals } = bucket;
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

function tokenSplit(totals: Totals) {
  const total = totals.uncachedInput + totals.cachedInput + totals.cacheWrite + totals.output;
  return {
    uncachedInput: Math.round(totals.uncachedInput),
    cachedInput: Math.round(totals.cachedInput),
    cacheWrite: Math.round(totals.cacheWrite),
    output: Math.round(totals.output),
    reasoning: Math.round(totals.reasoning),
    total: Math.round(total),
  };
}

function cacheHitRate(tokens: {
  cachedInput: number;
  total: number;
  output: number;
}): number | null {
  const input = tokens.total - tokens.output;
  return input <= 0 ? null : share(tokens.cachedInput / input);
}

function costPerMillion(
  costUsd: number,
  totalTokens: number,
  unpricedTokens: number,
): number | null {
  const priced = totalTokens - unpricedTokens;
  return priced <= 0 ? null : roundTo((costUsd / priced) * 1_000_000, 2);
}

function presentTotals(totals: Totals, sessions: number | null) {
  const tokens = tokenSplit(totals);
  const unpricedTokens = Math.round(totals.unpricedTokens);
  const categorySum =
    totals.category.input +
    totals.category.cacheRead +
    totals.category.cacheWrite +
    totals.category.output;
  return {
    tokens,
    cacheHitRate: cacheHitRate(tokens),
    costUsd: money(totals.costUsd),
    cacheSavingsUsd: money(totals.cacheSavingsUsd),
    costPerMillionTokens: costPerMillion(totals.costUsd, tokens.total, unpricedTokens),
    categoryCostUsd: {
      input: money(totals.category.input),
      cacheRead: money(totals.category.cacheRead),
      cacheWrite: money(totals.category.cacheWrite),
      output: money(totals.category.output),
      other: money(Math.max(0, totals.costUsd - categorySum)),
    },
    speedUsd: {
      standard: money(Math.max(0, totals.costUsd - totals.fast - totals.ultrafast)),
      fast: money(totals.fast),
      ultrafast: money(totals.ultrafast),
      premium: money(totals.premium),
    },
    records: totals.records,
    sessions,
    unpricedTokens,
    costSourceShare: {
      modelPriced: share(
        totals.records === 0
          ? 0
          : (totals.records - totals.providerReportedRecords - totals.unpricedRecords) /
              totals.records,
      ),
      providerReported: share(
        totals.records === 0 ? 0 : totals.providerReportedRecords / totals.records,
      ),
      unpriced: share(totals.records === 0 ? 0 : totals.unpricedRecords / totals.records),
    },
  };
}

export function compactUsageSummary(input: {
  readonly summary: UsageSummary;
  readonly window: UsageWindow;
  readonly topModels: number;
  readonly provider?: UsageProviderKind;
  readonly model?: string;
}): UsageSummaryReadyResult {
  const buckets = input.summary.buckets.filter(
    (bucket) =>
      (input.provider === undefined || bucket.provider === input.provider) &&
      (input.model === undefined || bucket.model === input.model),
  );
  const sources = input.summary.sources.filter(
    (source) => input.provider === undefined || source.fingerprint.provider === input.provider,
  );
  const grand = emptyTotals();
  const byProvider = new Map<string, Totals>();
  const byModel = new Map<string, Totals & { provider: string; model: string }>();
  const byDay = new Map<string, { tokens: number; costUsd: number }>();
  for (const bucket of buckets) {
    addBucket(grand, bucket);
    const provider = byProvider.get(bucket.provider) ?? emptyTotals();
    addBucket(provider, bucket);
    byProvider.set(bucket.provider, provider);
    const modelKey = `${bucket.provider}\u0000${bucket.model}`;
    const model = byModel.get(modelKey) ?? {
      ...emptyTotals(),
      provider: bucket.provider,
      model: bucket.model,
    };
    addBucket(model, bucket);
    byModel.set(modelKey, model);
    const day = byDay.get(bucket.day) ?? { tokens: 0, costUsd: 0 };
    day.tokens += bucketTokenCount(bucket);
    day.costUsd += bucket.costUsd;
    byDay.set(bucket.day, day);
  }
  const tokens = tokenSplit(grand);
  const providerRows = [...byProvider.entries()]
    .map(([provider, totals]) => {
      const presented = presentTotals(totals, null);
      return {
        provider,
        tokens: presented.tokens,
        cacheHitRate: presented.cacheHitRate,
        costUsd: presented.costUsd,
        costPerMillionTokens: presented.costPerMillionTokens,
        records: presented.records,
        unpricedTokens: presented.unpricedTokens,
        tokenShare: share(tokens.total === 0 ? 0 : presented.tokens.total / tokens.total),
        costShare: share(grand.costUsd === 0 ? 0 : totals.costUsd / grand.costUsd),
      };
    })
    .sort((left, right) => right.tokens.total - left.tokens.total || right.costUsd - left.costUsd);
  const modelRows = [...byModel.values()]
    .map((totals) => {
      const presented = presentTotals(totals, null);
      return {
        provider: totals.provider,
        model: totals.model,
        tokens: presented.tokens,
        cacheHitRate: presented.cacheHitRate,
        costUsd: presented.costUsd,
        costPerMillionTokens: presented.costPerMillionTokens,
        records: presented.records,
        unpricedRecords: totals.unpricedRecords,
        unpricedTokens: presented.unpricedTokens,
        tokenShare: share(tokens.total === 0 ? 0 : presented.tokens.total / tokens.total),
        costShare: share(grand.costUsd === 0 ? 0 : totals.costUsd / grand.costUsd),
      };
    })
    .sort((left, right) => right.tokens.total - left.tokens.total || right.costUsd - left.costUsd)
    .slice(0, input.topModels);
  const sourceCounts = { ok: 0, partial: 0, missing: 0, failed: 0, refreshing: 0 };
  let malformed = 0;
  let sessions = 0;
  for (const source of sources) {
    sourceCounts[source.status] += 1;
    if (source.refreshing === true) sourceCounts.refreshing += 1;
    malformed += source.malformedRecords;
    sessions += source.distinctSessions;
  }
  const notices = [
    "Totals are from the last saved Usage scan, not a new read of history.",
    "Reasoning tokens are included in output. Total tokens are uncached input, cache reads, cache writes, and output.",
    "Cost is an API-equivalent estimate, not the subscription bill. Premium is the Fast and Ultrafast amount above standard rates.",
  ];
  if (input.summary.sources.some((source) => source.refreshing === true)) {
    notices.push("The saved scan is marked refreshing, so the newest turns may be missing.");
  }
  if (malformed > 0) notices.push(`${malformed} malformed usage records were skipped.`);
  if (sourceCounts.failed > 0 || sourceCounts.partial > 0) {
    notices.push(
      `${sourceCounts.partial} history source(s) were partial and ${sourceCounts.failed} failed.`,
    );
  }
  if (input.model !== undefined) {
    notices.push("Session counts are omitted because they are not tracked per model.");
  }
  if (modelRows.length < byModel.size) {
    notices.push(`Showing the ${modelRows.length} models with the most tokens.`);
  }
  const presented = presentTotals(grand, input.model === undefined ? sessions : null);
  return {
    status: "ready",
    window: input.window,
    readAt: input.summary.readAt,
    refreshing: input.summary.sources.some((source) => source.refreshing === true),
    pricing: {
      status: input.summary.pricing.status,
      knownModels: input.summary.pricing.knownModels,
    },
    totals: presented,
    byProvider: providerRows,
    byModel: modelRows,
    byDay: [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({
        day,
        tokens: Math.round(totals.tokens),
        costUsd: money(totals.costUsd),
      })),
    sources: sourceCounts,
    notices,
  };
}

const ACCOUNT_CAP = 40;
const LIMITS_NOTE =
  "Last limits snapshot held in memory. This does not probe providers or redeem credits. Account emails, credential ids, and source URLs are omitted.";

function publicLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const trimmed = label.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes(":")
  ) {
    return undefined;
  }
  if (trimmed.includes(".") && !trimmed.includes(" ")) return undefined;
  return trimmed;
}

function limitWindow(window: ServerProviderUsageWindow) {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: roundTo(window.usedPercent, 1),
    remainingPercent: roundTo(100 - window.usedPercent, 1),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    ...(window.modelIds === undefined || window.modelIds.length === 0
      ? {}
      : { modelIds: window.modelIds.slice(0, 8) }),
  };
}

function resetCredits(limits: ServerProviderUsageLimits) {
  const credits = limits.resetCredits;
  if (credits === undefined) return {};
  return {
    resetCredits: {
      availableCount: credits.availableCount,
      ...(credits.nextExpiresAt === undefined ? {} : { nextExpiresAt: credits.nextExpiresAt }),
      ...(credits.options === undefined
        ? {}
        : {
            options: credits.options.slice(0, 6).map((option) => ({
              label: option.label,
              availableCount: option.availableCount,
              ...(option.expiresAt === undefined ? {} : { expiresAt: option.expiresAt }),
            })),
          }),
    },
  };
}

function unavailable(limits: ServerProviderUsageLimits) {
  return limits.unavailable === undefined
    ? {}
    : { unavailable: { reason: limits.unavailable.reason } };
}

export function compactUsageLimits(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
}): UsageLimitsResult {
  const accounts: Array<UsageLimitsResult["accounts"][number]> = [];
  for (const provider of input.providers) {
    if (provider.usageLimits === undefined) continue;
    const label = publicLabel(provider.displayName) ?? provider.driver;
    accounts.push({
      provider: provider.driver,
      instanceId: provider.instanceId,
      label,
      enabled: provider.enabled,
      source: "provider",
      checkedAt: provider.usageLimits.checkedAt,
      ...(provider.usageLimits.zeroSpendCap === true ? { zeroSpendCap: true } : {}),
      windows: provider.usageLimits.windows.map(limitWindow),
      ...resetCredits(provider.usageLimits),
      ...unavailable(provider.usageLimits),
    });
  }
  let unreadable = 0;
  for (const source of input.sources) {
    if (source.error !== undefined) unreadable += 1;
    const sourceLabel = publicLabel(source.label);
    for (const account of source.accounts) {
      accounts.push({
        provider: account.driver,
        label: publicLabel(account.plan) ?? account.driver,
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        source: "hub",
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
        checkedAt: account.usageLimits.checkedAt,
        ...(account.usageLimits.zeroSpendCap === true ? { zeroSpendCap: true } : {}),
        windows: account.usageLimits.windows.map(limitWindow),
        ...resetCredits(account.usageLimits),
        ...unavailable(account.usageLimits),
      });
    }
    for (const account of source.quotaAccounts ?? []) {
      const label = publicLabel(account.label) ?? "HTTP quota";
      accounts.push({
        provider: "http",
        ...(account.providerInstanceId === undefined
          ? {}
          : { instanceId: account.providerInstanceId }),
        label,
        source: "http",
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
        checkedAt: source.checkedAt,
        windows: account.windows.map((window) => ({
          id: window.id,
          kind: window.kind,
          label: window.label,
          usedPercent: roundTo(window.usedPercent, 1),
          remainingPercent: roundTo(100 - window.usedPercent, 1),
          ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        })),
      });
    }
  }
  accounts.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label),
  );
  const notices: string[] = [];
  if (unreadable > 0) {
    notices.push(
      `${unreadable} limit source(s) could not be read. Last good readings are included when they were kept.`,
    );
  }
  const shown = accounts.slice(0, ACCOUNT_CAP);
  if (shown.length < accounts.length) {
    notices.push(`Showing ${shown.length} of ${accounts.length} accounts.`);
  }
  return { snapshot: "cached", note: LIMITS_NOTE, accounts: shown, notices };
}
