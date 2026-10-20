import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    label TEXT,
    added_by TEXT NOT NULL CHECK (added_by IN ('user', 'agent')),
    UNIQUE(project_id, path)
  )`;
});
