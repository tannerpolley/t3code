import {
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ThreadUsageSummary as UsageSummarySchema,
  ProviderTurnId,
  ProviderOptionSelections,
  type ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import * as SqlClient from "effect/sql/SqlClient";

import { UsageService } from "../usage/UsageService.ts";

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
  costVersion: Schema.optional(Schema.Literal(1)),
});
export type StoredThreadUsageSummary = typeof StoredThreadUsageSummary.Type;
const usageThrottle = Symbol("threadUsageThrottle");

/** Symbols stay inside the server and are ignored by JSON and the shell wire schema. */
export function threadUsageShellFields(stored: StoredThreadUsageSummary | undefined) {
  if (stored === undefined) return {};
  const {
    turnId,
    completed,
    costVersion: _costVersion,
    weeklyLimitPercent: _legacyPercent,
    ...usageSummary
  } = stored;
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
  cost?: { readonly costUsd: number; readonly costProviderInstanceId: ProviderInstanceId },
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
    ...cost,
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
const decodeOptions = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderOptionSelections));
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
  // Projection replay also runs without pricing services; startup fills those costs once.
  const usage = yield* Effect.serviceOption(UsageService);
  const priceTokens = Option.isSome(usage) ? yield* usage.value.tokenPricer : undefined;
  const modelTokens =
    row === undefined || priceTokens === undefined
      ? []
      : yield* sql<{
          readonly instance_id: ProviderInstanceId;
          readonly model: string | null;
          readonly options_json: string | null;
          readonly input_tokens: number;
          readonly cached_input_tokens: number;
          readonly cache_creation_tokens: number;
          readonly output_tokens: number;
        }>`
    WITH selections AS (
      SELECT pt.payload_json AS turn_json, p.provider_instance_id AS instance_id,
        COALESCE(json_extract(r.payload_json, '$.modelSelection.model'),
          json_extract(p.payload_json, '$.nativeMetadata.modelSelection.model'),
          json_extract(s.payload_json, '$.modelSelection.model'),
          json_extract(s.payload_json, '$.model'),
          json_extract(t.payload_json, '$.modelSelection.model')) AS model,
        CASE WHEN pt.run_attempt_id IS NOT NULL THEN json_extract(r.payload_json, '$.modelSelection.options')
          WHEN json_type(p.payload_json, '$.nativeMetadata.modelSelection') = 'object' THEN json_extract(p.payload_json, '$.nativeMetadata.modelSelection.options')
          WHEN json_type(s.payload_json, '$.modelSelection') = 'object' THEN json_extract(s.payload_json, '$.modelSelection.options')
          WHEN p.owner_node_id IS NULL THEN json_extract(t.payload_json, '$.modelSelection.options') END AS options_json
      FROM orchestration_v2_projection_provider_turns pt
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = pt.provider_thread_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
      LEFT JOIN orchestration_v2_projection_subagents s ON s.subagent_id = p.owner_node_id
      WHERE pt.thread_id = ${threadId} AND p.driver IN ('codex', 'claudeAgent')
        AND (p.owner_node_id IS NULL OR p.provider_thread_id = t.active_provider_thread_id)
        AND (json_type(pt.payload_json, '$.turnTokenUsage.inputTokens') = 'integer'
          OR json_type(pt.payload_json, '$.turnTokenUsage.outputTokens') = 'integer')
    )
    SELECT instance_id, model, options_json,
      SUM(COALESCE(json_extract(turn_json, '$.turnTokenUsage.inputTokens'), 0)) AS input_tokens,
      SUM(COALESCE(json_extract(turn_json, '$.turnTokenUsage.cachedInputTokens'), 0)) AS cached_input_tokens,
      SUM(COALESCE(json_extract(turn_json, '$.turnTokenUsage.cacheCreationTokens'), 0)) AS cache_creation_tokens,
      SUM(COALESCE(json_extract(turn_json, '$.turnTokenUsage.outputTokens'), 0)) AS output_tokens
    FROM selections GROUP BY instance_id, model, options_json
  `;
  const providerThread = row === undefined ? undefined : yield* decodeThread(row.provider_json);
  let costUsd: number | undefined;
  for (const tokens of modelTokens) {
    if (tokens.instance_id !== providerThread?.providerInstanceId) continue;
    if (tokens.model === null) {
      costUsd = undefined;
      break;
    }
    const options =
      tokens.options_json === null ? undefined : yield* decodeOptions(tokens.options_json);
    const tier = getProviderOptionStringSelectionValue(options, "serviceTier");
    const speed =
      tier === "ultrafast"
        ? "ultrafast"
        : tier === "priority" ||
            getProviderOptionBooleanSelectionValue(options, "fastMode") === true
          ? "fast"
          : "standard";
    // ponytail: native turns retain only the latest selection and may lack a tier; exact historical
    // reroutes and speed changes need per-turn model selections from the adapters.
    const cost = priceTokens!(tokens.model, turnTotals(tokens), speed);
    if (cost === null) {
      costUsd = undefined;
      break;
    }
    costUsd = (costUsd ?? 0) + cost;
  }
  const summary =
    row === undefined
      ? undefined
      : deriveThreadUsageSummary(
          yield* decodeTurn(row.turn_json),
          providerThread,
          row.thread_tokens ?? undefined,
          costUsd === undefined || providerThread === undefined
            ? undefined
            : {
                costUsd,
                costProviderInstanceId: providerThread.providerInstanceId,
              },
        );
  if (summary === undefined) {
    yield* sql`DELETE FROM orchestration_v2_projection_thread_usage WHERE thread_id = ${threadId}`;
  } else {
    // Marked once priced, whatever the result, so the startup backfill visits each summary once.
    const payload = yield* encodeSummary(
      priceTokens === undefined ? summary : { ...summary, costVersion: 1 },
    );
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

/** Upgrade old/missing costs once, without waiting for another provider turn. */
export const backfillThreadUsageCosts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Threads without a summary have no usage to price; their first turn writes a priced one.
  const threads = yield* sql<{ readonly thread_id: ThreadId }>`
    SELECT thread_id FROM orchestration_v2_projection_thread_usage
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.costVersion') END IS NULL
  `;
  for (const thread of threads) yield* refreshThreadUsageSummary(thread.thread_id);
});
