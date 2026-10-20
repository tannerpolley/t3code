import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Closed issue cleanup needs archived workers without scanning the thread table.
  yield* sql`DROP INDEX issue_roadmap_parent_idx`;
  yield* sql`DROP INDEX issue_roadmap_linked_issue_idx`;
  yield* sql`DROP INDEX issue_roadmap_linked_pr_idx`;
  yield* sql`
    CREATE INDEX issue_roadmap_parent_idx ON orchestration_v2_projection_threads(
      json_extract(payload_json, '$.lineage.parentThreadId'), thread_id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX issue_roadmap_linked_issue_idx ON orchestration_v2_projection_threads(
      lower(json_extract(payload_json, '$.linkedIssue.host')),
      lower(json_extract(payload_json, '$.linkedIssue.repository')),
      json_extract(payload_json, '$.linkedIssue.number'), thread_id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX issue_roadmap_linked_pr_idx ON orchestration_v2_projection_threads(
      lower(json_extract(payload_json, '$.linkedPullRequest.repository')),
      json_extract(payload_json, '$.linkedPullRequest.number'), thread_id
    ) WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.linkedPullRequest.number') IS NOT NULL
  `;
});
