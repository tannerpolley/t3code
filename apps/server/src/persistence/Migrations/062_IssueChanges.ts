import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Authoritative approval/write records, separate from rebuilt orchestration projections.
  yield* sql`CREATE TABLE issue_changes (
    change_id TEXT PRIMARY KEY,
    requesting_thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    issue_number INTEGER,
    proposal_json TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_by TEXT,
    status TEXT NOT NULL,
    steps_json TEXT NOT NULL DEFAULT '{}',
    in_flight_step TEXT,
    result TEXT,
    UNIQUE(requesting_thread_id, client_request_id)
  )`;
  yield* sql`CREATE INDEX issue_changes_thread ON issue_changes(requesting_thread_id, decision)`;
  yield* sql`CREATE INDEX issue_changes_issue ON issue_changes(host, repository, issue_number, decision)`;
  yield* sql`CREATE TABLE issue_body_baselines (
    host TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    body TEXT NOT NULL,
    change_id TEXT NOT NULL,
    PRIMARY KEY(host, issue_id)
  )`;
  yield* sql`CREATE TABLE issue_change_targets (
    change_id TEXT NOT NULL REFERENCES issue_changes(change_id),
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    PRIMARY KEY(change_id, host, repository, issue_number)
  )`;
  yield* sql`CREATE INDEX issue_change_targets_issue ON issue_change_targets(host, repository, issue_number)`;
});
