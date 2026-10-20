import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error'
      AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
  `;
});
