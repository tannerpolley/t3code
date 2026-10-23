import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Pending publication and notification work shares the choice's transaction.
  yield* sql`CREATE TABLE owner_decisions (
    id TEXT PRIMARY KEY,
    requesting_thread_id TEXT NOT NULL,
    requesting_project_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL,
    request_comment_json TEXT,
    choice_comment_json TEXT,
    chosen_option_id TEXT,
    chosen_by TEXT,
    chosen_at TEXT,
    withdrawal_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    pending_publish TEXT,
    pending_delivery INTEGER NOT NULL DEFAULT 0,
    pending_label INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    UNIQUE(requesting_thread_id, client_request_id)
  )`;
  yield* sql`CREATE INDEX owner_decisions_target ON owner_decisions(host, repository, issue_number)`;
  yield* sql`CREATE INDEX owner_decisions_pending ON owner_decisions(updated_at)
    WHERE pending_publish IS NOT NULL OR pending_delivery = 1 OR pending_label = 1`;
});
