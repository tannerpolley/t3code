import { UsageDay, type UsageModelFilter, type UsageSummaryInput } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageService from "./UsageService.ts";
import {
  compactThreadActivity,
  compactUsageLimits,
  compactUsageSummary,
  DEFAULT_THREAD_LIMIT,
  MAX_THREAD_CANDIDATES,
  resolveHourlyBounds,
  resolveUsageWindow,
  type UsageLimitsReport,
  type UsageSummaryReport,
  type UsageThreadsReport,
} from "./usageReport.ts";

export class UsageAnalyticsError extends Schema.TaggedError<UsageAnalyticsError>()(
  "UsageAnalyticsError",
  {
    reason: Schema.Literals(["invalidWindow", "readFailed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const usageDay = Schema.decodeUnknownSync(UsageDay);

const int = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
};
const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export class UsageAnalytics extends Context.Service<
  UsageAnalytics,
  {
    readonly readSummary: (input: {
      readonly sinceDay?: string | undefined;
      readonly untilDay?: string | undefined;
      readonly timeZone?: string | undefined;
      readonly resolution?: "day" | "hour" | undefined;
      readonly sinceTime?: string | undefined;
      readonly untilTime?: string | undefined;
      readonly modelFilter?: UsageModelFilter | undefined;
    }) => Effect.Effect<UsageSummaryReport, UsageAnalyticsError>;
    readonly readThreads: (input: {
      readonly sinceDay?: string | undefined;
      readonly untilDay?: string | undefined;
      readonly timeZone?: string | undefined;
      readonly projectId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<UsageThreadsReport, UsageAnalyticsError>;
    readonly readLimits: () => Effect.Effect<UsageLimitsReport>;
  }
>()("t3/usage/UsageAnalytics") {}

const make = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const limitSources = yield* UsageLimitSources.UsageLimitSources;

  const windowOf = Effect.fn("UsageAnalytics.window")(function* (input: {
    readonly sinceDay?: string | undefined;
    readonly untilDay?: string | undefined;
    readonly timeZone?: string | undefined;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const resolved = resolveUsageWindow({ ...input, nowMs });
    if (!resolved.ok) {
      return yield* new UsageAnalyticsError({ reason: "invalidWindow", detail: resolved.detail });
    }
    return resolved;
  });

  const readSummary = Effect.fn("UsageAnalytics.readSummary")(function* (input: {
    readonly sinceDay?: string | undefined;
    readonly untilDay?: string | undefined;
    readonly timeZone?: string | undefined;
    readonly resolution?: "day" | "hour" | undefined;
    readonly sinceTime?: string | undefined;
    readonly untilTime?: string | undefined;
    readonly modelFilter?: UsageModelFilter | undefined;
  }) {
    const resolved = yield* windowOf(input);
    const hourly = resolveHourlyBounds(input);
    if (!hourly.ok) {
      return yield* new UsageAnalyticsError({ reason: "invalidWindow", detail: hourly.detail });
    }
    const request: UsageSummaryInput = {
      sinceDay: usageDay(resolved.sinceDay),
      untilDay: usageDay(resolved.untilDay),
      timeZone: resolved.timeZone,
      provisional: true,
      ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      ...(input.sinceTime === undefined ? {} : { sinceTime: input.sinceTime }),
      ...(input.untilTime === undefined ? {} : { untilTime: input.untilTime }),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    };
    // provisional reads the usage cache. Skipping tier resolution keeps this off the
    // orchestration database; a cache miss still scans session files, as opening Usage does.
    const summary = yield* usage
      .readSummary(request, { skipServiceTierResolution: true })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "invalidWindow"
            ? new UsageAnalyticsError({ reason: "invalidWindow", detail: error.detail })
            : new UsageAnalyticsError({ reason: "readFailed", detail: "Could not read usage." }),
        ),
      );
    return compactUsageSummary(summary);
  });

  const readThreads = Effect.fn("UsageAnalytics.readThreads")(function* (input: {
    readonly sinceDay?: string | undefined;
    readonly untilDay?: string | undefined;
    readonly timeZone?: string | undefined;
    readonly projectId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly limit?: number | undefined;
  }) {
    const resolved = yield* windowOf(input);
    const scanLimit = MAX_THREAD_CANDIDATES + 1;
    // No completed_at index exists, and a date scan of provider turns has stalled multi-GB
    // databases. Candidates come from the active-thread index, then each thread's turns are
    // read through the thread_id index.
    const candidateRows = yield* (
      input.threadId !== undefined
        ? sql<{
            readonly thread_id: string;
            readonly project_id: string;
            readonly title: string;
            readonly relationship: string | null;
          }>`
            SELECT thread_id, project_id, title,
              CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.lineage.relationshipToParent')
              END AS relationship
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${input.threadId}
              ${input.projectId === undefined ? sql`` : sql`AND project_id = ${input.projectId}`}
          `
        : input.projectId !== undefined
          ? sql<{
              readonly thread_id: string;
              readonly project_id: string;
              readonly title: string;
              readonly relationship: string | null;
            }>`
              SELECT thread_id, project_id, title,
                CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.lineage.relationshipToParent')
                END AS relationship
              FROM orchestration_v2_projection_threads
              WHERE project_id = ${input.projectId}
                AND deleted_at IS NULL
                AND archived_at IS NULL
                AND updated_at >= ${resolved.sinceIso}
              ORDER BY updated_at DESC
              LIMIT ${scanLimit}
            `
          : sql<{
              readonly thread_id: string;
              readonly project_id: string;
              readonly title: string;
              readonly relationship: string | null;
            }>`
              SELECT thread_id, project_id, title,
                CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.lineage.relationshipToParent')
                END AS relationship
              FROM orchestration_v2_projection_threads
                INDEXED BY orchestration_v2_projection_threads_active_shell_idx
              WHERE deleted_at IS NULL
                AND archived_at IS NULL
                AND updated_at >= ${resolved.sinceIso}
              ORDER BY updated_at DESC
              LIMIT ${scanLimit}
            `
    ).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new UsageAnalyticsError({
            reason: "readFailed",
            detail: "Could not read thread usage.",
            cause,
          }),
      ),
    );
    const truncated = input.threadId === undefined && candidateRows.length > MAX_THREAD_CANDIDATES;
    const selected = truncated ? candidateRows.slice(0, MAX_THREAD_CANDIDATES) : candidateRows;
    const candidates = selected.map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      title: row.title,
      subagent: row.relationship === "subagent",
    }));
    if (candidates.length === 0) {
      return compactThreadActivity({
        readAt: DateTime.formatIso(yield* DateTime.now),
        window: resolved,
        limit: input.limit ?? DEFAULT_THREAD_LIMIT,
        truncated,
        candidates,
        turns: [],
        context: [],
        projectTitles: new Map(),
      });
    }
    const ids = encodeIdList(candidates.map((candidate) => candidate.threadId));
    const projectIds = encodeIdList([
      ...new Set(candidates.map((candidate) => candidate.projectId)),
    ]);
    const [turnRows, contextRows, projectRows] = yield* Effect.all(
      [
        sql<{
          readonly thread_id: string;
          readonly input_tokens: number | null;
          readonly cached_input_tokens: number | null;
          readonly cache_creation_tokens: number | null;
          readonly output_tokens: number | null;
          readonly reasoning_tokens: number | null;
          readonly other_tokens: number | null;
          readonly partial_turns: number | null;
          readonly turns: number | null;
          readonly model: string | null;
          readonly service_tier: string | null;
        }>`
          WITH turns AS MATERIALIZED (
            SELECT thread_id, completed_at, ordinal,
              json_extract(payload_json, '$.model') AS model,
              json_extract(payload_json, '$.serviceTier') AS service_tier,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.inputTokens'), 0) AS input_tokens,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.cachedInputTokens'), 0) AS cached_input_tokens,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.cacheCreationTokens'), 0) AS cache_creation_tokens,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.outputTokens'), 0) AS output_tokens,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.reasoningTokens'), 0) AS reasoning_tokens,
              COALESCE(json_extract(payload_json, '$.turnTokenUsage.otherUsage.inputTokens'), 0)
                + COALESCE(json_extract(payload_json, '$.turnTokenUsage.otherUsage.outputTokens'), 0) AS other_tokens,
              CASE
                WHEN json_extract(payload_json, '$.turnTokenUsage.usageStatus') = 'complete' THEN 0
                ELSE 1
              END AS partial
            FROM orchestration_v2_projection_provider_turns
            WHERE thread_id IN (SELECT value FROM json_each(${ids}))
              AND status IN ('completed', 'interrupted', 'failed', 'cancelled')
              AND completed_at >= ${resolved.sinceIso}
              AND completed_at < ${resolved.untilIso}
              AND json_type(payload_json, '$.turnTokenUsage') = 'object'
              AND json_extract(payload_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial')
              AND json_extract(payload_json, '$.turnTokenUsage.localCommand') IS NOT 1
          )
          SELECT grouped.thread_id,
            SUM(grouped.input_tokens) AS input_tokens,
            SUM(grouped.cached_input_tokens) AS cached_input_tokens,
            SUM(grouped.cache_creation_tokens) AS cache_creation_tokens,
            SUM(grouped.output_tokens) AS output_tokens,
            SUM(grouped.reasoning_tokens) AS reasoning_tokens,
            SUM(grouped.other_tokens) AS other_tokens,
            SUM(grouped.partial) AS partial_turns,
            COUNT(*) AS turns,
            (
              SELECT latest.model FROM turns AS latest
              WHERE latest.thread_id = grouped.thread_id
              ORDER BY latest.completed_at DESC, latest.ordinal DESC
              LIMIT 1
            ) AS model,
            (
              SELECT latest.service_tier FROM turns AS latest
              WHERE latest.thread_id = grouped.thread_id
              ORDER BY latest.completed_at DESC, latest.ordinal DESC
              LIMIT 1
            ) AS service_tier
          FROM turns AS grouped
          GROUP BY grouped.thread_id
        `,
        // Same one-row lookup the thread list uses, so the usage index stops at the latest reading.
        sql<{
          readonly thread_id: string;
          readonly used_tokens: number | null;
          readonly max_tokens: number | null;
          readonly auto_compact_threshold: number | null;
          readonly usage_updated_at: string | null;
          readonly model: string | null;
          readonly service_tier: string | null;
        }>`
          SELECT t.thread_id,
            json_extract(usage.payload_json, '$.tokenUsage.usedTokens') AS used_tokens,
            json_extract(usage.payload_json, '$.tokenUsage.maxTokens') AS max_tokens,
            json_extract(usage.payload_json, '$.tokenUsage.autoCompactThreshold') AS auto_compact_threshold,
            json_extract(usage.payload_json, '$.tokenUsage.updatedAt') AS usage_updated_at,
            json_extract(usage.payload_json, '$.model') AS model,
            json_extract(usage.payload_json, '$.serviceTier') AS service_tier
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_provider_turns usage
            ON usage.provider_turn_id = (
              SELECT turn.provider_turn_id
              FROM orchestration_v2_projection_provider_turns turn
                INDEXED BY orchestration_v2_projection_provider_turns_usage_idx
              WHERE turn.provider_thread_id = CASE
                  WHEN json_valid(t.payload_json)
                  THEN json_extract(t.payload_json, '$.activeProviderThreadId')
                END
                AND json_type(turn.payload_json, '$.tokenUsage') = 'object'
              ORDER BY julianday(json_extract(turn.payload_json, '$.tokenUsage.updatedAt')) DESC,
                turn.ordinal DESC
              LIMIT 1
            )
          WHERE t.thread_id IN (SELECT value FROM json_each(${ids}))
        `,
        sql<{ readonly project_id: string; readonly title: string }>`
          SELECT project_id, title
          FROM projection_projects
          WHERE project_id IN (SELECT value FROM json_each(${projectIds}))
        `,
      ],
      { concurrency: 1 },
    ).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new UsageAnalyticsError({
            reason: "readFailed",
            detail: "Could not read thread usage.",
            cause,
          }),
      ),
    );
    return compactThreadActivity({
      readAt: DateTime.formatIso(yield* DateTime.now),
      window: resolved,
      limit: input.limit ?? DEFAULT_THREAD_LIMIT,
      truncated,
      candidates,
      turns: turnRows.map((row) => ({
        threadId: row.thread_id,
        inputTokens: int(row.input_tokens),
        cachedInputTokens: int(row.cached_input_tokens),
        cacheCreationTokens: int(row.cache_creation_tokens),
        outputTokens: int(row.output_tokens),
        reasoningTokens: int(row.reasoning_tokens),
        otherTokens: int(row.other_tokens),
        partialTurns: int(row.partial_turns),
        turns: int(row.turns),
        model: text(row.model),
        serviceTier: text(row.service_tier),
      })),
      context: contextRows.flatMap((row) => {
        if (row.used_tokens === null) return [];
        return [
          {
            threadId: row.thread_id,
            usedTokens: int(row.used_tokens),
            maxTokens: row.max_tokens === null ? undefined : int(row.max_tokens),
            autoCompactThreshold:
              row.auto_compact_threshold === null ? undefined : int(row.auto_compact_threshold),
            usageUpdatedAt: text(row.usage_updated_at),
            model: text(row.model),
            serviceTier: text(row.service_tier),
          },
        ];
      }),
      projectTitles: new Map(projectRows.map((row) => [row.project_id, row.title])),
    });
  });

  const readLimits = Effect.fn("UsageAnalytics.readLimits")(function* () {
    const [listed, sources] = yield* Effect.all([providers.getProviders, limitSources.current], {
      concurrency: 2,
    });
    return compactUsageLimits({
      readAt: DateTime.formatIso(yield* DateTime.now),
      providers: listed,
      sources,
    });
  });

  return UsageAnalytics.of({ readSummary, readThreads, readLimits });
});

export const layer = Layer.effect(UsageAnalytics, make);
