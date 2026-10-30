import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const payload = "CASE WHEN json_valid(new.payload_json) THEN new.payload_json ELSE '{}' END";
  const entries = `json_insert(
    COALESCE(json_extract(${payload}, '$.repositoryOrchestration.handoffHistory'), '[]'),
    '$[#]', json_object('threadId', json_extract(${payload}, '$.lineage.parentThreadId')),
    '$[#]', json_object('threadId', json_extract(${payload}, '$.forkedFrom.threadId'))
  )`;
  // An outer UPSERT overrides INSERT OR IGNORE in triggers, so deduplicate before inserting.
  for (const operation of ["insert", "update"] as const) {
    yield* sql.unsafe(`DROP TRIGGER orchestration_v2_thread_references_${operation}`);
    yield* sql.unsafe(`CREATE TRIGGER orchestration_v2_thread_references_${operation}
      AFTER ${operation === "insert" ? "INSERT" : "UPDATE OF payload_json"} ON orchestration_v2_projection_threads
      ${operation === "update" ? "WHEN old.payload_json IS NOT new.payload_json" : ""}
      BEGIN
        ${operation === "update" ? "DELETE FROM orchestration_v2_projection_thread_references WHERE owner_thread_id = new.thread_id;" : ""}
        INSERT INTO orchestration_v2_projection_thread_references
        SELECT DISTINCT new.thread_id, json_extract(value, '$.threadId')
        FROM json_each(${entries})
        WHERE json_extract(value, '$.threadId') IS NOT NULL;
      END`);
  }
});
