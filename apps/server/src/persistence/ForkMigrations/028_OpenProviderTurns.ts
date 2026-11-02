import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Lets startup recovery find provider turns left open without scanning every turn.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_open_idx
    ON orchestration_v2_projection_provider_turns(thread_id)
    WHERE status IN ('pending', 'running')
  `;
});
