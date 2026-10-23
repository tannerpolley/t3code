import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream shell snapshots now batch these counts directly from the source index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_insert`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_delete`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_turn_item_count_move`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_turn_item_counts`;
});
