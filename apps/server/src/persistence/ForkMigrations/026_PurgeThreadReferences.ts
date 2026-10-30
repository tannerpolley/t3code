import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_thread_references (
    owner_thread_id TEXT NOT NULL,
    referenced_thread_id TEXT NOT NULL,
    PRIMARY KEY (owner_thread_id, referenced_thread_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX orchestration_v2_thread_references_target_idx
    ON orchestration_v2_projection_thread_references(referenced_thread_id, owner_thread_id)`;
  yield* sql`CREATE INDEX orchestration_v2_threads_deleted_idx
    ON orchestration_v2_projection_threads(deleted_at, thread_id)`;
  yield* sql`CREATE INDEX orchestration_v2_issue_work_owner_idx
    ON orchestration_v2_projection_issue_work(owner_thread_id)`;
  yield* sql`CREATE INDEX inline_shell_delivery_events_thread_idx
    ON inline_shell_delivery_events(thread_id)`;

  // JSON arrays cannot have a reverse lookup index; keep one through payload updates and rebuilds.
  const entries = (column: string) => {
    const payload = `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
    return sql.literal(`json_insert(
      COALESCE(json_extract(${payload}, '$.repositoryOrchestration.handoffHistory'), '[]'),
      '$[#]', json_object('threadId', json_extract(${payload}, '$.lineage.parentThreadId')),
      '$[#]', json_object('threadId', json_extract(${payload}, '$.forkedFrom.threadId'))
    )`);
  };
  yield* sql`CREATE TRIGGER orchestration_v2_thread_references_insert
    AFTER INSERT ON orchestration_v2_projection_threads BEGIN
      INSERT OR IGNORE INTO orchestration_v2_projection_thread_references
      SELECT new.thread_id, json_extract(value, '$.threadId')
      FROM json_each(${entries("new.payload_json")})
      WHERE json_extract(value, '$.threadId') IS NOT NULL;
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_thread_references_update
    AFTER UPDATE OF payload_json ON orchestration_v2_projection_threads
    WHEN old.payload_json IS NOT new.payload_json BEGIN
      DELETE FROM orchestration_v2_projection_thread_references WHERE owner_thread_id = new.thread_id;
      INSERT OR IGNORE INTO orchestration_v2_projection_thread_references
      SELECT new.thread_id, json_extract(value, '$.threadId')
      FROM json_each(${entries("new.payload_json")})
      WHERE json_extract(value, '$.threadId') IS NOT NULL;
    END`;
  yield* sql`CREATE TRIGGER orchestration_v2_thread_references_delete
    AFTER DELETE ON orchestration_v2_projection_threads BEGIN
      DELETE FROM orchestration_v2_projection_thread_references WHERE owner_thread_id = old.thread_id;
    END`;
  yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_thread_references
    SELECT thread.thread_id, json_extract(entry.value, '$.threadId')
    FROM orchestration_v2_projection_threads AS thread,
      json_each(${entries("thread.payload_json")}) AS entry
    WHERE json_extract(entry.value, '$.threadId') IS NOT NULL`;
});
