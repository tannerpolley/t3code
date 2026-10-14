import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Independent associations survive projection rebuilds and do not claim repository work.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE issue_thread_links (
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    PRIMARY KEY(host, repository, issue_number, thread_id)
  )`;
});
