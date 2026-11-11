import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX issue_roadmap_parent_idx`;
  yield* sql`DROP INDEX issue_roadmap_linked_issue_idx`;
  yield* sql`DROP INDEX issue_roadmap_linked_pr_idx`;
  yield* sql`
    CREATE INDEX issue_roadmap_parent_idx ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END, thread_id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX issue_roadmap_linked_issue_idx ON orchestration_v2_projection_threads(
      lower(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedIssue.host') END),
      lower(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedIssue.repository') END),
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedIssue.number') END, thread_id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX issue_roadmap_linked_pr_idx ON orchestration_v2_projection_threads(
      lower(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedPullRequest.repository') END),
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedPullRequest.number') END, thread_id
    ) WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.linkedPullRequest.number') END IS NOT NULL
  `;
  yield* sql`DROP INDEX issue_work_lineage_root_idx`;
  yield* sql`CREATE INDEX issue_work_lineage_root_idx
    ON orchestration_v2_projection_threads(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END)`;
});
