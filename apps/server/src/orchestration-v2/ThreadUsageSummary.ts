import {
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ThreadUsageSummary as UsageSummarySchema,
  ProviderTurnId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { threadWeeklyLimitEstimate, WeeklyLimitEstimates } from "../usage/WeeklyLimitEstimates.ts";

import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  UsageTokenTotals,
} from "@t3tools/contracts";

export class DeferThreadUsageSummary extends Context.Reference<boolean>(
  "t3/sidebar/DeferThreadUsageSummary",
  { defaultValue: () => false },
) {}

export const StoredThreadUsageSummary = Schema.Struct({
  ...UsageSummarySchema.fields,
  turnId: ProviderTurnId,
  completed: Schema.Boolean,
});
export type StoredThreadUsageSummary = typeof StoredThreadUsageSummary.Type;
const usageThrottle = Symbol("threadUsageThrottle");

/** Symbols stay inside the server and are ignored by JSON and the shell wire schema. */
export function threadUsageShellFields(stored: StoredThreadUsageSummary | undefined) {
  if (stored === undefined) return {};
  const { turnId, completed, ...usageSummary } = stored;
  return { usageSummary, [usageThrottle]: { turnId, completed } };
}
export function threadUsageThrottleState(shell: OrchestrationV2ThreadShell) {
  return (
    shell as OrchestrationV2ThreadShell & {
      [usageThrottle]?: { readonly turnId: string; readonly completed: boolean };
    }
  )[usageThrottle];
}

/** Derive only numbers from persisted provider records, never transcript items. */
export function deriveThreadUsageSummary(
  turn: OrchestrationV2ProviderTurn | undefined,
  providerThread: OrchestrationV2ProviderThread | undefined,
  threadTokens: number | undefined,
  weeklyLimit?: { readonly costUsd: number; readonly weeklyLimitPercent?: number },
): StoredThreadUsageSummary | undefined {
  if (!turn || !providerThread || !["codex", "claudeAgent"].includes(providerThread.driver))
    return undefined;
  const usage = turn.turnTokenUsage;
  const context = turn.tokenUsage ?? providerThread.contextUsage;
  if (!usage && !context) return undefined;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    context?.usedTokens === undefined &&
    threadTokens === undefined
  )
    return undefined;
  return {
    turnId: turn.id,
    completed: turn.completedAt !== null,
    partial: usage?.usageStatus !== "complete",
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { latestTurnTokens: inputTokens + outputTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(usage?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(threadTokens === undefined ? {} : { threadTokens }),
    ...(context?.usedTokens === undefined ? {} : { contextTokens: context.usedTokens }),
    ...(context?.maxTokens == null ? {} : { contextWindow: context.maxTokens }),
    ...weeklyLimit,
  };
}

/** Prompt tokens a turn reports include its cache reads and writes; pricing splits them out. */
function turnTotals(row: {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_creation_tokens: number;
  readonly output_tokens: number;
}): UsageTokenTotals {
  return {
    uncachedInputTokens: Math.max(
      0,
      row.input_tokens - row.cached_input_tokens - row.cache_creation_tokens,
    ),
    cachedInputTokens: row.cached_input_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: 0,
  };
}
const decodeTurn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(StoredThreadUsageSummary));

/** Materialize on usage events so ordinary text/tool shell refreshes never scan turn history. */
const refresh = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly turn_json: string;
    readonly provider_json: string;
    readonly thread_tokens: number | null;
  }>`
    SELECT pt.payload_json AS turn_json, p.payload_json AS provider_json,
      SUM(CASE WHEN p.driver IN ('codex', 'claudeAgent') THEN json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens') + json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens') END) OVER () AS thread_tokens
    FROM orchestration_v2_projection_provider_turns pt
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = pt.provider_thread_id
    JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
    WHERE pt.thread_id = ${threadId}
      AND (p.owner_node_id IS NULL OR p.provider_thread_id = t.active_provider_thread_id)
    ORDER BY pt.started_at DESC, pt.ordinal DESC, pt.provider_turn_id DESC LIMIT 1
  `;
  const row = rows[0];
  const estimates = (yield* WeeklyLimitEstimates).current;
  // Each run's model, so a thread that switched models prices every part at its own rate.
  const modelTokens =
    row === undefined || estimates === null
      ? []
      : yield* sql<{
          readonly instance_id: string;
          readonly model: string;
          readonly input_tokens: number;
          readonly cached_input_tokens: number;
          readonly cache_creation_tokens: number;
          readonly output_tokens: number;
        }>`
          SELECT json_extract(r.payload_json, '$.modelSelection.instanceId') AS instance_id,
            json_extract(r.payload_json, '$.modelSelection.model') AS model,
            SUM(COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens'), 0)) AS input_tokens,
            SUM(COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cachedInputTokens'), 0)) AS cached_input_tokens,
            SUM(COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.cacheCreationTokens'), 0)) AS cache_creation_tokens,
            SUM(COALESCE(json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens'), 0)) AS output_tokens
          FROM orchestration_v2_projection_provider_turns pt
          JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = pt.provider_thread_id
          JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
          JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
          JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
          WHERE pt.thread_id = ${threadId}
            AND p.driver IN ('codex', 'claudeAgent')
            AND (p.owner_node_id IS NULL OR p.provider_thread_id = t.active_provider_thread_id)
          GROUP BY instance_id, model
        `;
  const providerThread = row === undefined ? undefined : yield* decodeThread(row.provider_json);
  const summary =
    row === undefined
      ? undefined
      : deriveThreadUsageSummary(
          yield* decodeTurn(row.turn_json),
          providerThread,
          row.thread_tokens ?? undefined,
          providerThread === undefined
            ? undefined
            : threadWeeklyLimitEstimate(
                modelTokens.map((tokens) => ({
                  instanceId: tokens.instance_id,
                  model: tokens.model,
                  totals: turnTotals(tokens),
                })),
                providerThread.providerInstanceId,
                estimates,
              ),
        );
  if (summary === undefined) {
    yield* sql`DELETE FROM orchestration_v2_projection_thread_usage WHERE thread_id = ${threadId}`;
  } else {
    const payload = yield* encodeSummary(summary);
    yield* sql`INSERT INTO orchestration_v2_projection_thread_usage (thread_id, payload_json)
      VALUES (${threadId}, ${payload}) ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json`;
  }
});

export const refreshThreadUsageSummary = (threadId: ThreadId) =>
  refresh(threadId).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Skipping unreadable thread usage summary", { threadId }),
    ),
  );
/** Replay batches materialize once per thread, rather than once per historical turn event. */
export const refreshAllThreadUsageSummaries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* sql<{
    readonly thread_id: string;
  }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
  for (const thread of threads) yield* refreshThreadUsageSummary(thread.thread_id as ThreadId);
});
