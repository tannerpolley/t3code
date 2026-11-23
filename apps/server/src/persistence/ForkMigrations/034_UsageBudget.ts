import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX usage_budget_completed_turn_idx
    ON orchestration_v2_projection_provider_turns(completed_at)
    WHERE completed_at IS NOT NULL
  `;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN action TEXT NOT NULL DEFAULT 'prompt'`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN usage_budget_report_json TEXT`;
});
