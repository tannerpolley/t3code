import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The question asked about a pending change, so a decision made elsewhere can close it.
  yield* sql`ALTER TABLE issue_changes ADD COLUMN question_request_id TEXT`;
});
