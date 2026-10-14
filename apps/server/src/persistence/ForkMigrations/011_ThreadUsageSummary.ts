import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Frozen v11 backfill: only the JSON fields this migration consumes are validated. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_thread_usage (
    thread_id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  const nonNegative = (column: string, path: string, nullable = false) =>
    `(json_type(${column}, '${path}') IS NULL ${nullable ? `OR json_type(${column}, '${path}') = 'null'` : ""} OR (json_type(${column}, '${path}') = 'integer' AND json_extract(${column}, '${path}') >= 0))`;
  const valid = [
    "json_type(turn_json, '$.id') = 'text'",
    "json_type(provider_json, '$.driver') = 'text'",
    "(json_type(turn_json, '$.turnTokenUsage') IS NULL OR (json_type(turn_json, '$.turnTokenUsage') = 'object' AND json_extract(turn_json, '$.turnTokenUsage.usageScope') = 'main_agent' AND json_type(turn_json, '$.turnTokenUsage.hasSubagents') IN ('true', 'false') AND json_extract(turn_json, '$.turnTokenUsage.usageStatus') IN ('complete', 'partial', 'unavailable') AND (json_extract(turn_json, '$.turnTokenUsage.usageStatus') <> 'complete' OR (json_type(turn_json, '$.turnTokenUsage.inputTokens') = 'integer' AND json_type(turn_json, '$.turnTokenUsage.outputTokens') = 'integer'))))",
    ...[
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
      "reasoningTokens",
    ].map((field) => nonNegative("turn_json", `$.turnTokenUsage.${field}`)),
    ...["turn_json", "provider_json"].flatMap((column) => {
      const path = column === "turn_json" ? "$.tokenUsage" : "$.contextUsage";
      return [
        `(json_type(${column}, '${path}') IS NULL OR json_type(${column}, '${path}') = 'null' OR (json_type(${column}, '${path}') = 'object' AND json_type(${column}, '${path}.usedTokens') = 'integer'))`,
        nonNegative(column, `${path}.usedTokens`),
        nonNegative(column, `${path}.maxTokens`, true),
      ];
    }),
  ].join(" AND ");
  const source = `WITH source AS (
      SELECT pt.thread_id, pt.provider_turn_id, pt.ordinal, pt.started_at, pt.completed_at,
        CASE WHEN json_valid(pt.payload_json) THEN pt.payload_json ELSE '{}' END AS turn_json,
        CASE WHEN json_valid(p.payload_json) THEN p.payload_json ELSE '{}' END AS provider_json,
        p.driver
      FROM orchestration_v2_projection_provider_turns pt
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = pt.provider_thread_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE p.owner_node_id IS NULL OR p.provider_thread_id = t.active_provider_thread_id
    )`;
  const invalid = yield* sql.unsafe<{ readonly count: number }>(
    `${source} SELECT COUNT(*) AS count FROM source WHERE NOT COALESCE((${valid}), 0)`,
  );
  if ((invalid[0]?.count ?? 0) > 0)
    yield* Effect.logWarning("Migration 11 skipped invalid usage records", {
      count: invalid[0]?.count,
    });
  yield* sql.unsafe(`
    INSERT INTO orchestration_v2_projection_thread_usage (thread_id, payload_json)
    ${source}, counts AS (
      SELECT *,
        CASE WHEN json_type(turn_json, '$.turnTokenUsage.inputTokens') = 'integer' AND json_extract(turn_json, '$.turnTokenUsage.inputTokens') >= 0
          THEN json_extract(turn_json, '$.turnTokenUsage.inputTokens') END AS input_tokens,
        CASE WHEN json_type(turn_json, '$.turnTokenUsage.outputTokens') = 'integer' AND json_extract(turn_json, '$.turnTokenUsage.outputTokens') >= 0
          THEN json_extract(turn_json, '$.turnTokenUsage.outputTokens') END AS output_tokens,
        CASE WHEN json_type(turn_json, '$.turnTokenUsage.cachedInputTokens') = 'integer' AND json_extract(turn_json, '$.turnTokenUsage.cachedInputTokens') >= 0
          THEN json_extract(turn_json, '$.turnTokenUsage.cachedInputTokens') END AS cached_tokens,
        CASE WHEN json_type(turn_json, '$.tokenUsage') = 'object' THEN json_extract(turn_json, '$.tokenUsage.usedTokens') ELSE json_extract(provider_json, '$.contextUsage.usedTokens') END AS context_tokens,
        CASE WHEN json_type(turn_json, '$.tokenUsage') = 'object' THEN json_extract(turn_json, '$.tokenUsage.maxTokens') ELSE json_extract(provider_json, '$.contextUsage.maxTokens') END AS context_window
      FROM source
      WHERE ${valid}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY started_at DESC, ordinal DESC, provider_turn_id DESC) AS rank,
        SUM(CASE WHEN driver IN ('codex', 'claudeAgent') THEN input_tokens + output_tokens END) OVER (PARTITION BY thread_id) AS thread_tokens
      FROM counts
    )
    SELECT thread_id, json_patch('{}', json_object(
      'turnId', provider_turn_id,
      'completed', json(CASE WHEN completed_at IS NULL THEN 'false' ELSE 'true' END),
      'partial', json(CASE WHEN json_extract(turn_json, '$.turnTokenUsage.usageStatus') = 'complete' THEN 'false' ELSE 'true' END),
      'latestTurnTokens', input_tokens + output_tokens,
      'inputTokens', input_tokens,
      'cachedInputTokens', cached_tokens,
      'outputTokens', output_tokens,
      'threadTokens', thread_tokens,
      'contextTokens', CASE WHEN typeof(context_tokens) = 'integer' AND context_tokens >= 0 THEN context_tokens END,
      'contextWindow', CASE WHEN typeof(context_window) = 'integer' AND context_window >= 0 THEN context_window END
    ))
    FROM ranked WHERE rank = 1 AND driver IN ('codex', 'claudeAgent')
      AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR thread_tokens IS NOT NULL OR (typeof(context_tokens) = 'integer' AND context_tokens >= 0))
  `);
});
