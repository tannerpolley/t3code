import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Empty run_id is the runless bucket; contract run IDs are nonempty. Keep
  // counts with their source rows so imports, replay, rollback and rebuild all
  // use the same owner. Streaming changes no count unless the item's run moves.
  yield* sql`
    CREATE TABLE orchestration_v2_projection_turn_item_counts (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      item_count INTEGER NOT NULL CHECK (item_count >= 0),
      PRIMARY KEY (thread_id, run_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
    SELECT thread_id, COALESCE(run_id, ''), COUNT(*)
    FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, COALESCE(run_id, '')
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_count_insert
    AFTER INSERT ON orchestration_v2_projection_turn_items
    BEGIN
      INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
      VALUES (NEW.thread_id, COALESCE(NEW.run_id, ''), 1)
      ON CONFLICT(thread_id, run_id) DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_count_delete
    AFTER DELETE ON orchestration_v2_projection_turn_items
    BEGIN
      UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id = COALESCE(OLD.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = OLD.thread_id AND run_id = COALESCE(OLD.run_id, '') AND item_count = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_turn_item_count_move
    AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.run_id IS NOT NEW.run_id
    BEGIN
      UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id = COALESCE(OLD.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = OLD.thread_id AND run_id = COALESCE(OLD.run_id, '') AND item_count = 0;
      INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_id, item_count)
      VALUES (NEW.thread_id, COALESCE(NEW.run_id, ''), 1)
      ON CONFLICT(thread_id, run_id) DO UPDATE SET item_count = item_count + 1;
    END
  `;
});
