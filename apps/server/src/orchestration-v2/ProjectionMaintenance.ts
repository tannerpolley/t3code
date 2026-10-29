import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (
    betweenPages?: Effect.Effect<void>,
    toolOutputRetentionDays?: number | null,
  ) => Effect.Effect<
    {
      readonly trimmedEventCount: number;
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly purgedThreadCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_issue_comment_receipts`;
          yield* sql`DELETE FROM orchestration_v2_projection_issue_work`;
          yield* sql`DELETE FROM orchestration_v2_projection_repository_orchestration`;
          yield* sql`DELETE FROM orchestration_v2_projection_issue_work_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Keep thread.created as the verification and replay anchor; clients recognize deletion by thread.deleted event type.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ];
    // Read-state events preserve updatedAt and supersede only each other. Activity events supersede both groups.
    const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // Subagent snapshots stay intact because later rows can reference an earlier prompt.
    // Commanded turn items stay for command-result replay.
    // Small pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    // Deleted threads have no restore path. The grace lets the effects that
    // follow a delete (provider stop, worktree cleanup) finish first.
    const DELETED_THREAD_RETENTION = Duration.days(7);

    // Forks, subagents, handoff successors and unfinished work can still replay a deleted
    // thread. Purge unreferenced children first so their parents become eligible.
    const purgeCandidates = (cutoff: string) =>
      sql<{ readonly thread_id: string }>`
        WITH thread_payload AS (
          SELECT CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END AS payload
          FROM orchestration_v2_projection_threads
        ), referenced(thread_id) AS (
          SELECT json_extract(payload, '$.lineage.parentThreadId') FROM thread_payload
          UNION SELECT json_extract(payload, '$.forkedFrom.threadId') FROM thread_payload
          UNION SELECT json_extract(entry.value, '$.threadId')
            FROM thread_payload, json_each(payload, '$.repositoryOrchestration.handoffHistory') AS entry
          UNION SELECT task.child_thread_id
            FROM orchestration_v2_projection_subagents AS task
            JOIN orchestration_v2_projection_threads AS owner ON owner.thread_id = task.thread_id
            WHERE task.origin = 'app_owned' AND owner.deleted_at IS NULL
              AND CASE WHEN json_valid(task.payload_json)
                THEN json_extract(task.payload_json, '$.result') END IS NULL
          UNION SELECT source_thread_id FROM orchestration_v2_projection_context_transfers
            WHERE status NOT IN ('consumed', 'failed', 'superseded')
          UNION SELECT owner_thread_id FROM orchestration_v2_projection_issue_work
          UNION SELECT thread_id FROM orchestration_v2_effect_outbox
            WHERE status IN ('pending', 'running')
        )
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at <= ${cutoff}
          AND thread_id NOT IN (SELECT thread_id FROM referenced WHERE thread_id IS NOT NULL)
        ORDER BY deleted_at ASC, thread_id ASC
        LIMIT ${COMPACTION_PAGE_SIZE}
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
        while ((yield* batch).length === COMPACTION_PAGE_SIZE) yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      });

    const purgeDeletedThread = Effect.fn("ProjectionMaintenance.purgeDeletedThread")(function* (
      threadId: string,
    ) {
      // Runs while the thread's nodes and subagents still exist: a provider
      // thread they own may carry an already purged child's id. Rows another
      // thread still reaches stay, as that thread's replay recreates them.
      yield* sql`
        DELETE FROM orchestration_v2_projection_provider_threads
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
      `;
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
          LIMIT ${COMPACTION_PAGE_SIZE}
        )
        RETURNING sequence
      `);
      yield* drainBatches(sql`
        DELETE FROM orchestration_command_receipts WHERE rowid IN (
          SELECT rowid FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
          LIMIT ${COMPACTION_PAGE_SIZE}
        )
        RETURNING rowid
      `);
      for (const [table, column] of THREAD_ROWS_DELETED_IN_BATCHES) {
        yield* drainBatches(sql`
          DELETE FROM ${sql(table)} WHERE rowid IN (
            SELECT rowid FROM ${sql(table)} WHERE ${sql(column)} = ${threadId}
            LIMIT ${COMPACTION_PAGE_SIZE}
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
          const latestSequence = yield* eventStore.latestSequence();
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

    // Keep first/latest keyed events for replay order; page every event to bound sparse scans.
    const compactEventStore = Effect.fn("ProjectionMaintenance.compactEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
      toolOutputRetentionDays: number | null = null,
    ) {
      const trimCutoff =
        toolOutputRetentionDays !== null &&
        Number.isSafeInteger(toolOutputRetentionDays) &&
        toolOutputRetentionDays > 0
          ? DateTime.formatIso(
              DateTime.subtract(yield* DateTime.now, { days: toolOutputRetentionDays }),
            )
          : null;
      const marker = "[Tool output removed for age]";
      let trimmedEventCount = 0;
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly);
      let throughSequence = bounds[0]?.event_sequence ?? 0;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<string, number | null>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN ('message.updated', 'node.updated')
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'turn-item.updated'
                AND event.command_id IS NULL
                AND json_extract(event.payload_json, '$.type') <> 'subagent'
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'thread.pull-request-link-updated'
              THEN json_array(json_extract(event.payload_json, '$.host'),
                json_extract(event.payload_json, '$.repository'),
                json_extract(event.payload_json, '$.number'))
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_events AS event
          WHERE event.sequence <= ${throughSequence}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete: number[] = [];
        for (const row of page) {
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(row.sequence);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(row.sequence);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              (row.event_type === "turn-item.updated" && row.entity_id !== null)
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null) obsolete.push(candidate);
                oldestCandidateByEntityKey.set(key, row.sequence);
              }
            }
          }
        }
        if (trimCutoff !== null) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const row of page) {
                if (row.event_type !== "turn-item.updated" || row.application_event_version !== 2)
                  continue;
                const trimmed = yield* sql<{
                  readonly item_id: string;
                  readonly provider_turn_id: string;
                }>`
                UPDATE orchestration_events
                SET payload_json = json_remove(json_set(payload_json, '$.output', ${marker}), '$.viewedImagePath')
                WHERE sequence = ${row.sequence}
                  AND json_extract(payload_json, '$.type') IN ('command_execution', 'dynamic_tool')
                  AND json_type(payload_json, '$.output') IS NOT NULL
                  AND json_extract(payload_json, '$.output') IS NOT ${marker}
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_provider_turns AS turn
                    WHERE turn.provider_turn_id = json_extract(orchestration_events.payload_json, '$.providerTurnId')
                      AND turn.thread_id = orchestration_events.stream_id
                      AND turn.status IN ('completed', 'failed', 'cancelled', 'interrupted')
                      AND turn.completed_at < ${trimCutoff}
                  )
                RETURNING json_extract(payload_json, '$.id') AS item_id,
                  json_extract(payload_json, '$.providerTurnId') AS provider_turn_id
              `;
                for (const item of trimmed) {
                  yield* sql`
                  UPDATE orchestration_v2_projection_turn_items
                  SET payload_json = json_remove(json_set(payload_json, '$.output', ${marker}), '$.viewedImagePath')
                  WHERE turn_item_id = ${item.item_id} AND thread_id = ${row.stream_id}
                    AND provider_turn_id = ${item.provider_turn_id}
                `;
                  trimmedEventCount++;
                }
              }
            }),
          );
        }
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughSequence =
          rows.length <= COMPACTION_PAGE_SIZE ? 0 : (page.at(-1)?.sequence ?? 1) - 1;
        if (throughSequence > 0 || throughReceiptRowId > 0) yield* betweenPages;
      }

      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete = page
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughReceiptRowId = (page.at(-1)?.row_id ?? 1) - 1;
        if (rows.length <= COMPACTION_PAGE_SIZE) break;
        yield* betweenPages;
      }

      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, DELETED_THREAD_RETENTION),
      );
      let purgedThreadCount = 0;
      // Purging a child can free its parent, so ask again until nothing qualifies.
      while (true) {
        const candidates = yield* purgeCandidates(cutoff);
        if (candidates.length === 0) break;
        for (const { thread_id } of candidates) yield* purgeDeletedThread(thread_id);
        purgedThreadCount += candidates.length;
      }

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return {
        trimmedEventCount,
        deletedEventCount,
        deletedReceiptCount,
        purgedThreadCount,
        reclaimableBytes,
      };
    }, mapError("compact event store"));

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore,
    });
  }),
);
