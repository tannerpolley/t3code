import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_issue_work (
      host TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      node_id TEXT NOT NULL,
      issue_url TEXT NOT NULL,
      issue_title TEXT NOT NULL,
      owner_thread_id TEXT,
      status_comment_id TEXT,
      status_marker TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, repository_id, issue_id),
      UNIQUE (host, repository_id, issue_number)
    )
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_issue_comment_receipts (
      write_key TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      result_event_id TEXT,
      comment_id TEXT,
      marker TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_issue_work_requests (
      request_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      attempt_key TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_issue_work_requests_attempt
    ON orchestration_v2_projection_issue_work_requests(host, repository_id, issue_id, attempt_key)`;
  yield* sql`CREATE INDEX orchestration_v2_issue_work_requests_root
    ON orchestration_v2_projection_issue_work_requests(root_thread_id, host, repository_id, issue_id)`;
  yield* sql`
    CREATE INDEX orchestration_v2_issue_comment_effect_identity
    ON orchestration_v2_effect_outbox (
      effect_type, json_extract(payload_json, '$.issue.host'),
      json_extract(payload_json, '$.issue.repositoryId'), json_extract(payload_json, '$.issue.id'),
      json_extract(payload_json, '$.operation'), coalesce(json_extract(payload_json, '$.revision'), 0) DESC
    ) WHERE effect_type = 'issue.github.comment'
  `;
  // Only explicit stable bindings backfill ownership; titles and message URLs prove nothing.
  yield* sql`
    INSERT INTO orchestration_v2_projection_issue_work
      (host, repository_id, issue_id, issue_number, repository, node_id, issue_url,
       issue_title, owner_thread_id, status_marker, updated_at)
    SELECT json_extract(payload_json, '$.linkedIssue.host'),
      json_extract(payload_json, '$.linkedIssue.repositoryId'),
      json_extract(payload_json, '$.linkedIssue.id'),
      json_extract(payload_json, '$.linkedIssue.number'),
      json_extract(payload_json, '$.linkedIssue.repository'),
      json_extract(payload_json, '$.linkedIssue.nodeId'),
      json_extract(payload_json, '$.linkedIssue.url'),
      json_extract(payload_json, '$.linkedIssue.title'), thread_id,
      '<!-- t3-issue-status:' || json_extract(payload_json, '$.linkedIssue.host') || ':' ||
        json_extract(payload_json, '$.linkedIssue.repositoryId') || ':' ||
        json_extract(payload_json, '$.linkedIssue.id') || ' -->', updated_at
    FROM orchestration_v2_projection_threads
    WHERE json_type(payload_json, '$.linkedIssue') = 'object'
    ORDER BY created_at ASC, thread_id ASC
    ON CONFLICT(host, repository_id, issue_id) DO UPDATE SET
      owner_thread_id = excluded.owner_thread_id,
      updated_at = excluded.updated_at
  `;
});
