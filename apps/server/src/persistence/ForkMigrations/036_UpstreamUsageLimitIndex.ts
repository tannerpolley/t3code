import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork 019 built this index with its own predicate, so upstream 099's IF NOT EXISTS skipped it.
// Rebuild it exactly as 099 spells it so upstream's queries and INDEXED BY hints can use it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_usage_limit_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.class') = 'usage_limit'
        ELSE 0 END
  `;
});
