import { defaultArtifactSection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_artifacts ADD COLUMN section TEXT NOT NULL DEFAULT 'Files'`;
  yield* sql`CREATE TABLE project_artifact_sections (
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (project_id, name)
  )`;
  const rows = yield* sql<{ id: string; project_id: string; path: string }>`
    SELECT id, project_id, path FROM project_artifacts ORDER BY rowid`;
  for (const row of rows) {
    const section = defaultArtifactSection(row.path);
    yield* sql`UPDATE project_artifacts SET section = ${section} WHERE id = ${row.id}`;
    yield* sql`INSERT OR IGNORE INTO project_artifact_sections (project_id, name, position)
      SELECT ${row.project_id}, ${section}, COALESCE(MAX(position) + 1, 0)
      FROM project_artifact_sections WHERE project_id = ${row.project_id}`;
  }
});
