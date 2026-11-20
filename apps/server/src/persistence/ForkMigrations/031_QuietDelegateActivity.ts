import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const activeQuietWork = `type IN ('command_execution', 'dynamic_tool', 'subagent')
  AND status IN ('pending', 'running', 'waiting')
  AND CASE WHEN type = 'dynamic_tool' AND json_valid(payload_json)
    THEN json_extract(payload_json, '$.input.persistent') IS NOT 1 ELSE 1 END`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN last_provider_activity_at INTEGER`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_quiet_idx
    ON orchestration_v2_projection_runs(thread_id, run_id)
    WHERE status = 'running'
  `;
  // Already-running threads get a fresh interval on upgrade without replaying their histories.
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET last_provider_activity_at = CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER)
    WHERE thread_id IN (SELECT thread_id FROM orchestration_v2_projection_runs WHERE status = 'running')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_quiet_work_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE ${sql.literal(activeQuietWork)}
  `;
  // Streaming rows already write through here. Only boundaries and the first update in a minute
  // advance the clock, so a long stream stays active without writing the thread on every delta.
  for (const { table, condition, boundary } of [
    {
      table: "turn_items",
      condition: "NEW.run_id IS NOT NULL",
      boundary: "NEW.status IS NOT OLD.status",
    },
    {
      table: "messages",
      condition: "NEW.role = 'assistant'",
      boundary: "NEW.streaming IS NOT OLD.streaming",
    },
  ]) {
    for (const operation of ["INSERT", "UPDATE"] as const) {
      yield* sql`
        CREATE TRIGGER ${sql(`orchestration_v2_quiet_${table}_${operation.toLowerCase()}`)}
        AFTER ${sql.literal(operation)} ON ${sql(`orchestration_v2_projection_${table}`)}
        WHEN ${sql.literal(condition)}
          ${
            operation === "UPDATE"
              ? sql`AND (${sql.literal(boundary)}
                OR substr(NEW.updated_at, 1, 16) <> substr(OLD.updated_at, 1, 16))`
              : sql``
          }
        BEGIN
          UPDATE orchestration_v2_projection_threads
          SET last_provider_activity_at = MAX(
            COALESCE(last_provider_activity_at, -1),
            CAST(ROUND(unixepoch(NEW.updated_at, 'subsec') * 1000) AS INTEGER)
          )
          WHERE thread_id = NEW.thread_id;
        END
      `;
    }
  }
});
