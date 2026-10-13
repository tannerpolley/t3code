import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runtime_requests_pending_routed_idx
    ON orchestration_v2_projection_runtime_requests(json_extract(payload_json, '$.routedTo'), thread_id)
    WHERE status = 'pending'
  `;
});
