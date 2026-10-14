import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Finds turn-bound items left running, so startup recovery can end the ones
// whose run already ended without scanning every item (EndedRunTurnItems.ts).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_open_turn_bound_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE status = 'running'
      AND type NOT IN ('command_execution', 'dynamic_tool', 'subagent')
  `;
});
