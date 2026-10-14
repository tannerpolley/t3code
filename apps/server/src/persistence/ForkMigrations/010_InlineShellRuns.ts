import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE inline_shell_runs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    delivered_by TEXT,
    record_json TEXT NOT NULL,
    UNIQUE(thread_id, run_id)
  )`;
  yield* sql`CREATE INDEX inline_shell_runs_block ON inline_shell_runs(thread_id, block_id, sequence DESC)`;
  yield* sql`CREATE INDEX inline_shell_runs_pending ON inline_shell_runs(thread_id, sequence DESC) WHERE delivered_by IS NULL AND status <> 'running'`;
  yield* sql`CREATE INDEX inline_shell_runs_running ON inline_shell_runs(sequence) WHERE status = 'running'`;
  yield* sql`CREATE TABLE inline_shell_delivery_events (
    delivery_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt_id TEXT,
    provider_turn_id TEXT,
    message_id TEXT NOT NULL,
    record_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
