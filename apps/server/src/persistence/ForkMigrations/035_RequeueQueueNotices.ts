import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Queued issues now start their own workers, so entries a root notice left behind are queued again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_issue_work_requests
    SET queue_state = 'queued', notice_run_id = NULL,
      payload_json = json_remove(json_set(payload_json, '$.state', 'queued'), '$.noticeRunId', '$.notifiedAt')
    WHERE queue_state IN ('queued', 'needs_attention')
  `;
});
