import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The automatic title refresh reads each due thread's latest assistant message time. This
  // mirrors the existing latest-user index so that read is one seek, not a scan of the thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_latest_assistant_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'assistant'
  `;
});
