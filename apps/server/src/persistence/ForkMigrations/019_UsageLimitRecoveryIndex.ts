import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Guarded: one malformed historical payload would otherwise fail the index build, and with it
// startup. Queries repeat this exact expression so SQLite can use the index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error'
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.failure.class') END = 'usage_limit'
  `;
});
