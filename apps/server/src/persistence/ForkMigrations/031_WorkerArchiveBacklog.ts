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
  yield* sql`INSERT INTO worker_archive_backlog (id, cutoff)
    VALUES (1, ${DateTime.formatIso(yield* DateTime.now)})`;
});
