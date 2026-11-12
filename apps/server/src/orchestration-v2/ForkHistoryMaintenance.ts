import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const PAGE_SIZE = 50;

export const maintainForkHistory = Effect.fn("ForkHistoryMaintenance.run")(function* (
  betweenPages: Effect.Effect<void>,
  retentionDays: number | null,
) {
  const sql = yield* SqlClient.SqlClient;
  // Deleted threads have no restore path. The grace lets the effects that
  // follow a delete (provider stop, worktree cleanup) finish first.
  const DELETED_THREAD_RETENTION = Duration.days(1);

  // Forks, subagents, handoff successors and unfinished work can still replay a deleted
  // thread. Purge unreferenced children first so their parents become eligible.
  const purgeCandidates = (cutoff: string, afterDeletedAt: string, afterThreadId: string) =>
    sql<{ readonly thread_id: string; readonly deleted_at: string }>`
        SELECT thread_id, deleted_at FROM orchestration_v2_projection_threads
        WHERE deleted_at <= ${cutoff}
          AND (deleted_at, thread_id) > (${afterDeletedAt}, ${afterThreadId})
        ORDER BY deleted_at ASC, thread_id ASC
        LIMIT ${PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);

  const isReferenced = (threadId: string) =>
    sql<{ readonly referenced: number }>`
        SELECT
          EXISTS (SELECT 1 FROM orchestration_v2_projection_thread_references
            WHERE referenced_thread_id = ${threadId})
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_subagents AS task
            JOIN orchestration_v2_projection_threads AS owner ON owner.thread_id = task.thread_id
            WHERE task.child_thread_id = ${threadId}
              AND task.origin = 'app_owned' AND owner.deleted_at IS NULL
              AND CASE WHEN json_valid(task.payload_json)
                THEN json_extract(task.payload_json, '$.result') END IS NULL
          )
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers
            WHERE source_thread_id = ${threadId} AND status NOT IN ('consumed', 'failed', 'superseded'))
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_issue_work
            WHERE owner_thread_id = ${threadId})
          OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND status IN ('pending', 'running'))
          AS referenced
      `.pipe(NodeSqliteClient.readOnly);

  // Each batch is its own statement, so the writer is never held for long.
  const THREAD_ROWS_DELETED_IN_BATCHES = [
    ["orchestration_v2_events", "thread_id"],
    ["orchestration_v2_command_receipts", "thread_id"],
    ["orchestration_v2_projection_turn_items", "thread_id"],
    ["orchestration_v2_turn_item_positions", "thread_id"],
    ["orchestration_v2_projection_nodes", "thread_id"],
    ["orchestration_v2_projection_messages", "thread_id"],
    ["orchestration_v2_projection_runs", "thread_id"],
    ["orchestration_v2_projection_run_attempts", "thread_id"],
    ["orchestration_v2_projection_provider_turns", "thread_id"],
    ["orchestration_v2_projection_runtime_requests", "thread_id"],
    ["orchestration_v2_projection_plans", "thread_id"],
    ["orchestration_v2_projection_checkpoints", "thread_id"],
    ["orchestration_v2_projection_checkpoint_scopes", "thread_id"],
    ["orchestration_v2_projection_context_handoffs", "thread_id"],
    // Transfer events are written to the target's stream.
    ["orchestration_v2_projection_context_transfers", "target_thread_id"],
    ["orchestration_v2_projection_subagents", "thread_id"],
    ["orchestration_v2_effect_outbox", "thread_id"],
    ["projection_thread_messages", "thread_id"],
    ["inline_shell_delivery_events", "thread_id"],
    ["inline_shell_runs", "thread_id"],
    ["mcp_app_model_context", "thread_id"],
  ] as const;
  // Small rows, removed in one transaction with thread.created: verify pairs
  // that event with the thread row, and the V1 importer re-imports any V1
  // projection_threads row whose V2 thread.created is gone.
  const THREAD_ROWS_DELETED_LAST = [
    ["orchestration_v2_projection_threads", "thread_id"],
    ["orchestration_v2_projection_provider_session_bindings", "thread_id"],
    ["orchestration_v2_projection_thread_usage", "thread_id"],
    ["orchestration_v2_projection_issue_work_requests", "root_thread_id"],
    ["orchestration_v2_legacy_imports", "thread_id"],
    ["projection_threads", "thread_id"],
    ["projection_thread_pull_requests", "thread_id"],
    ["projection_thread_sessions", "thread_id"],
    ["issue_thread_links", "thread_id"],
  ] as const;

  const drainBatches =
    /* Runs once per table for each purged thread; purgeDeletedThread owns the span. */
    Effect.fnUntraced(function* <E>(batch: Effect.Effect<ReadonlyArray<unknown>, E>) {
      while ((yield* batch).length === PAGE_SIZE) yield* Effect.yieldNow;
      yield* Effect.yieldNow;
    });

  const purgeDeletedThread = Effect.fn("ProjectionMaintenance.purgeDeletedThread")(function* (
    threadId: string,
  ) {
    // Runs while the thread's nodes and subagents still exist: a provider
    // thread they own may carry an already purged child's id. Rows another
    // thread still reaches stay, as that thread's replay recreates them.
    yield* drainBatches(sql`
        DELETE FROM orchestration_v2_projection_provider_threads
        WHERE rowid IN (
          SELECT rowid FROM orchestration_v2_projection_provider_threads
          WHERE (
            thread_id = ${threadId}
            OR owner_node_id IN (
              SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId}
            )
            OR provider_thread_id IN (
              SELECT provider_thread_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId}
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id = orchestration_v2_projection_provider_threads.thread_id
              AND thread.thread_id <> ${threadId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_nodes AS node
            WHERE node.node_id = orchestration_v2_projection_provider_threads.owner_node_id
              AND node.thread_id <> ${threadId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_subagents AS task
            WHERE task.provider_thread_id =
                orchestration_v2_projection_provider_threads.provider_thread_id
              AND task.thread_id <> ${threadId}
          )
          LIMIT ${PAGE_SIZE}
        )
        RETURNING rowid
      `);
    // thread.created and the stream's newest event go with the thread row,
    // so verify never sees the thread or the newest sequence half removed.
    yield* drainBatches(sql`
        DELETE FROM orchestration_events WHERE sequence IN (
          SELECT sequence FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type <> 'thread.created'
            AND sequence < (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            )
          LIMIT ${PAGE_SIZE}
        )
        RETURNING sequence
      `);
    yield* drainBatches(sql`
        DELETE FROM orchestration_command_receipts WHERE rowid IN (
          SELECT rowid FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          LIMIT ${PAGE_SIZE}
        )
        RETURNING rowid
      `);
    for (const [table, column] of THREAD_ROWS_DELETED_IN_BATCHES) {
      yield* drainBatches(sql`
          DELETE FROM ${sql(table)} WHERE rowid IN (
            SELECT rowid FROM ${sql(table)} WHERE ${sql(column)} = ${threadId}
            LIMIT ${PAGE_SIZE}
          )
          RETURNING rowid
        `);
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
            DELETE FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          `;
        // Verify expects the projection cursor at the newest thread event.
        // When this thread held it, pull the cursor back to what remains.
        const latestSequence =
          (yield* sql<{
            readonly sequence: number;
          }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`)[0]
            ?.sequence ?? 0;
        yield* sql`
            UPDATE orchestration_v2_projection_metadata SET last_sequence = ${latestSequence}
            WHERE projection_name = 'thread-projections' AND last_sequence > ${latestSequence}
          `;
        for (const [table, column] of THREAD_ROWS_DELETED_LAST) {
          yield* sql`DELETE FROM ${sql(table)} WHERE ${sql(column)} = ${threadId}`;
        }
        // Sessions can be shared; keep one another thread is still bound to.
        yield* sql`
            DELETE FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id = ${threadId}
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.provider_session_id =
                  orchestration_v2_projection_provider_sessions.provider_session_id
              )
          `;
      }),
    );
  });

  let trimmedEventCount = 0;
  if (retentionDays !== null && Number.isSafeInteger(retentionDays) && retentionDays > 0) {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: retentionDays }),
    );
    const marker = "[Tool output removed for age]";
    let cursor = 0;
    while (true) {
      const rows = yield* sql<{
        readonly row_id: number;
        readonly thread_id: string;
        readonly turn_item_id: string;
      }>`
        SELECT item.rowid AS row_id, item.thread_id, item.turn_item_id
        FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_provider_turns AS turn
          ON turn.thread_id = item.thread_id AND turn.provider_turn_id = item.provider_turn_id
        WHERE item.rowid > ${cursor}
          AND item.type IN ('command_execution', 'dynamic_tool')
          AND json_type(item.payload_json, '$.output') IS NOT NULL
          AND json_extract(item.payload_json, '$.output') IS NOT ${marker}
          AND turn.status IN ('completed', 'failed', 'cancelled', 'interrupted')
          AND turn.completed_at < ${cutoff}
        ORDER BY item.rowid LIMIT ${PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly);
      if (rows.length === 0) break;
      for (const row of rows) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE orchestration_v2_projection_turn_items
            SET payload_json = json_remove(json_set(payload_json, '$.output', ${marker}), '$.viewedImagePath')
            WHERE thread_id = ${row.thread_id} AND turn_item_id = ${row.turn_item_id}`;
            yield* sql`UPDATE orchestration_events
            SET payload_json = json_remove(json_set(payload_json, '$.output', ${marker}), '$.viewedImagePath')
            WHERE aggregate_kind = 'thread' AND stream_id = ${row.thread_id}
              AND event_type = 'turn-item.updated'
              AND json_extract(payload_json, '$.id') = ${row.turn_item_id}
              AND json_type(payload_json, '$.output') IS NOT NULL`;
          }),
        );
        trimmedEventCount++;
      }
      cursor = rows.at(-1)!.row_id;
      yield* betweenPages;
    }
  }
  const cutoff = DateTime.formatIso(
    DateTime.subtractDuration(yield* DateTime.now, DELETED_THREAD_RETENTION),
  );
  let purgedThreadCount = 0;
  // Purging a child can free a parent already visited in this sweep.
  while (true) {
    const beforeSweep = purgedThreadCount;
    let afterDeletedAt = "";
    let afterThreadId = "";
    while (true) {
      const candidates = yield* purgeCandidates(cutoff, afterDeletedAt, afterThreadId);
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        const references = yield* isReferenced(candidate.thread_id);
        if (references[0]?.referenced === 0) {
          yield* purgeDeletedThread(candidate.thread_id);
          purgedThreadCount++;
        }
        afterDeletedAt = candidate.deleted_at;
        afterThreadId = candidate.thread_id;
        yield* Effect.yieldNow;
        yield* betweenPages;
      }
    }
    if (beforeSweep === purgedThreadCount) break;
  }

  return { trimmedEventCount, purgedThreadCount };
});
