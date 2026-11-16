import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream migration 85 owns the replacement count table and its triggers.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`PRAGMA table_info(orchestration_v2_projection_turn_item_counts)`;
  if (columns.some(({ name }) => name === "run_key")) return;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_insert`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_delete`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_move`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_turn_item_counts`;
});
