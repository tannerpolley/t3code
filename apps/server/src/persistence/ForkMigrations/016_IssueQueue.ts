import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_issue_work_requests ADD COLUMN queue_state TEXT`;
  yield* sql`CREATE UNIQUE INDEX orchestration_v2_issue_queue_pending
    ON orchestration_v2_projection_issue_work_requests(host, repository_id, issue_id)
    WHERE queue_state IN ('queued', 'needs_attention')`;
});
