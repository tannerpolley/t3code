import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ActiveShellIndexEntry } from "./ProjectionStore.ts";

export const retainPendingTaskShellReferences = Effect.fn(
  "ShellStream.retainPendingTaskShellReferences",
)(function* (sql: SqlClient.SqlClient, index: ReadonlyArray<ActiveShellIndexEntry>) {
  // A superset is enough: the full-shell trim checks whether these tasks still keep each row.
  const references = yield* sql<{ owner_thread_id: string | null; child_thread_id: string | null }>`
      SELECT json_extract(task.value, '$.ownerThreadId') AS owner_thread_id,
        json_extract(task.value, '$.childThreadId') AS child_thread_id
      FROM orchestration_v2_projection_provider_threads provider,
        json_each(provider.payload_json, '$.pendingBackgroundTasks') task
      UNION ALL
      SELECT NULL, json_extract(item.payload_json, '$.childThreadId')
      FROM orchestration_v2_projection_turn_items item
      WHERE item.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
    `;
  const kept = new Set(
    references.flatMap((row) =>
      [row.owner_thread_id, row.child_thread_id].filter((id) => id !== null),
    ),
  );
  return index.map((entry) => (kept.has(entry.id) ? { ...entry, mayBeLive: true } : entry));
});
