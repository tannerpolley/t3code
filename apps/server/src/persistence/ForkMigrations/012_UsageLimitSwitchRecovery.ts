import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_limit_failures_recent
    ON orchestration_v2_projection_runs(completed_at, thread_id, run_id) WHERE status = 'failed'`;
  yield* sql`CREATE INDEX orchestration_v2_delegated_result_source
    ON orchestration_v2_projection_context_transfers(source_thread_id, json_extract(payload_json, '$.sourcePoint.runId'))
    WHERE type = 'subagent_result'`;
});
