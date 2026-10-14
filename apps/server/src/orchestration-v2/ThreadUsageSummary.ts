import {
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ThreadUsageSummary as UsageSummarySchema,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadUsageSummary,
} from "@t3tools/contracts";

/** Derive only numbers from persisted provider records, never transcript items. */
export function deriveThreadUsageSummary(
  turn: OrchestrationV2ProviderTurn | undefined,
  providerThread: OrchestrationV2ProviderThread | undefined,
  threadTokens: number | undefined,
): OrchestrationV2ThreadUsageSummary | undefined {
  if (!turn || !providerThread || !["codex", "claudeAgent"].includes(providerThread.driver))
    return undefined;
  const usage = turn.turnTokenUsage;
  const context = turn.tokenUsage ?? providerThread.contextUsage;
  if (!usage && !context) return undefined;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
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
  };
}
const decodeTurn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(UsageSummarySchema));

/** Materialize on usage events so ordinary text/tool shell refreshes never scan turn history. */
export const refreshThreadUsageSummary = Effect.fnUntraced(function* (threadId: ThreadId) {
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
  const summary =
    row === undefined
      ? undefined
      : deriveThreadUsageSummary(
          yield* decodeTurn(row.turn_json),
          yield* decodeThread(row.provider_json),
          row.thread_tokens ?? undefined,
        );
  if (summary === undefined) {
    yield* sql`DELETE FROM orchestration_v2_projection_thread_usage WHERE thread_id = ${threadId}`;
  } else {
    const payload = yield* encodeSummary(summary);
    yield* sql`INSERT INTO orchestration_v2_projection_thread_usage (thread_id, payload_json)
      VALUES (${threadId}, ${payload}) ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json`;
  }
});
