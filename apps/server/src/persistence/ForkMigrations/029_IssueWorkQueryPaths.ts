import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_issue_work_requests ADD COLUMN notice_run_id TEXT`;
  yield* sql`UPDATE orchestration_v2_projection_issue_work_requests
    SET notice_run_id = json_extract(payload_json, '$.noticeRunId') WHERE queue_state IS NOT NULL
      AND json_extract(payload_json, '$.noticeRunId') IS NOT NULL`;
  yield* sql`CREATE INDEX issue_queue_notice_run_idx
    ON orchestration_v2_projection_issue_work_requests(root_thread_id, notice_run_id)`;
  yield* sql`CREATE INDEX issue_work_lineage_root_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.rootThreadId'))`;
});
