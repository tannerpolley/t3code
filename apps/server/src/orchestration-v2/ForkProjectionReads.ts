import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const pendingRoutedRequestThreadIds = Effect.fn(
  "ForkProjectionReads.pendingRoutedRequestThreadIds",
)(function (sql: SqlClient.SqlClient, parentThreadId: ThreadId) {
  return sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests
    WHERE status = 'pending' AND json_extract(payload_json, '$.routedTo') = ${parentThreadId}
  `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));
});
