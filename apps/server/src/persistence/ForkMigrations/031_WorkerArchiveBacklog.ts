import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worker_archive_backlog (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cutoff TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE worker_archive_prior_restores (
    thread_id TEXT PRIMARY KEY,
    restored_at TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO worker_archive_prior_restores (thread_id, restored_at)
    SELECT thread_id, restored_at FROM (
      SELECT t.thread_id, (
        SELECT event.occurred_at FROM orchestration_events event
          INDEXED BY idx_orch_events_stream_sequence
        WHERE event.aggregate_kind = 'thread' AND event.stream_id = t.thread_id
          AND event.event_type = 'thread.unarchived'
        ORDER BY event.sequence DESC LIMIT 1
      ) AS restored_at
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
    ) WHERE restored_at IS NOT NULL`;
  yield* sql`INSERT INTO worker_archive_backlog (id, cutoff)
    VALUES (1, ${DateTime.formatIso(yield* DateTime.now)})`;
});
