import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_worker_page_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END,
      created_at DESC,
      thread_id DESC
    )
    WHERE archived_at IS NULL AND deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END = 'subagent'
  `;
});
