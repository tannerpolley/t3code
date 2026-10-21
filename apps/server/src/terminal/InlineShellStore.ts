import {
  InlineShellRunRecord,
  InlineShellRunError,
  type InlineShellRunLookupInput,
  type ThreadId,
  type RunId,
  type RunAttemptId,
  type ProviderTurnId,
  type MessageId,
} from "@t3tools/contracts";
import { inlineShellOutputTail, selectInlineShellContext } from "@t3tools/shared/inlineShell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { markInboxNoted, pendingInboxNote } from "../issues/IssueInboxRules.ts";

const encodeRecordJson = Schema.encodeSync(Schema.fromJsonString(InlineShellRunRecord));
const encodeRecord = (record: InlineShellRunRecord) =>
  encodeRecordJson({ ...record, output: inlineShellOutputTail(record.output) });
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(InlineShellRunRecord));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
type Row = { sequence: number; thread_id: string; record_json: string };
const NO_INBOX_NOTE = { ids: [] as ReadonlyArray<number>, text: "" };
export interface InlineShellDelivery {
  threadId: ThreadId;
  deliveryId: string;
  runId: RunId;
  attemptId: RunAttemptId | null;
  providerTurnId: ProviderTurnId | null;
  messageId: MessageId;
  text: string;
  compact: boolean;
  /** A new turn, not a steer: only a turn start carries the issue inbox line. */
  turnStart: boolean;
}

export class InlineShellStore extends Context.Service<
  InlineShellStore,
  {
    readonly get: (
      threadId: ThreadId,
      runId: string,
    ) => Effect.Effect<InlineShellRunRecord | null, InlineShellRunError>;
    readonly latest: (
      input: InlineShellRunLookupInput,
    ) => Effect.Effect<InlineShellRunRecord | null, InlineShellRunError>;
    readonly insert: (
      record: InlineShellRunRecord,
    ) => Effect.Effect<InlineShellRunRecord | null, InlineShellRunError>;
    readonly update: (record: InlineShellRunRecord) => Effect.Effect<boolean, InlineShellRunError>;
    readonly recover: () => Effect.Effect<number>;
    readonly deliver: <A, E, R>(
      input: InlineShellDelivery,
      send: (text: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | InlineShellRunError, R>;
  }
>()("t3/terminal/InlineShellStore") {}

export const layer = Layer.effect(
  InlineShellStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deliveries = yield* KeyedLock.make<string>();
    const activeThread = (threadId: string) =>
      sql`EXISTS (SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND archived_at IS NULL AND deleted_at IS NULL)`;
    const decodeRow = (row: Row) =>
      decodeRecord(row.record_json).pipe(
        Effect.map((record) => ({ ...record, sequence: row.sequence })),
        Effect.catch(() =>
          Effect.logWarning("Skipped malformed inline shell record", {
            sequence: row.sequence,
          }).pipe(Effect.as(null)),
        ),
      );
    const wrap =
      (threadId: ThreadId) =>
      <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.mapError((cause) => new InlineShellRunError({ threadId, cause })));
    const get = Effect.fn("InlineShellStore.get")(function* (threadId: ThreadId, runId: string) {
      const rows =
        yield* sql<Row>`SELECT sequence, thread_id, record_json FROM inline_shell_runs WHERE thread_id = ${threadId} AND run_id = ${runId}`;
      return rows[0] ? yield* decodeRow(rows[0]) : null;
    });
    const latest = Effect.fn("InlineShellStore.latest")(function* (
      input: InlineShellRunLookupInput,
    ) {
      const rows =
        yield* sql<Row>`SELECT sequence, thread_id, record_json FROM inline_shell_runs WHERE thread_id = ${input.threadId} AND block_id = ${input.blockId} ORDER BY sequence DESC LIMIT 1`;
      return rows[0] ? yield* decodeRow(rows[0]) : null;
    });
    const insert = Effect.fn("InlineShellStore.insert")(function* (record: InlineShellRunRecord) {
      yield* sql`INSERT INTO inline_shell_runs (thread_id, block_id, run_id, status, record_json) SELECT ${record.threadId}, ${record.blockId}, ${record.runId}, ${record.status}, ${encodeRecord(record)} WHERE ${activeThread(record.threadId)} ON CONFLICT(thread_id, run_id) DO NOTHING`;
      return yield* get(record.threadId, record.runId);
    });
    const update = Effect.fn("InlineShellStore.update")(function* (record: InlineShellRunRecord) {
      const rows =
        yield* sql`UPDATE inline_shell_runs SET status = ${record.status}, record_json = ${encodeRecord(record)} WHERE thread_id = ${record.threadId} AND run_id = ${record.runId} AND status = 'running' AND ${activeThread(record.threadId)} RETURNING sequence`;
      return rows.length > 0;
    });
    const recoverBatch = Effect.fn("InlineShellStore.recover")(function* () {
      // A bounded indexed batch, run in a scoped background fiber by the run service.
      const rows =
        yield* sql<Row>`SELECT sequence, thread_id, record_json FROM inline_shell_runs INDEXED BY inline_shell_runs_running WHERE status = 'running' AND ${sql`EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS thread WHERE thread.thread_id = inline_shell_runs.thread_id AND thread.archived_at IS NULL AND thread.deleted_at IS NULL)`} ORDER BY sequence LIMIT 100`;
      for (const row of rows) {
        const record = yield* decodeRow(row);
        if (record === null) {
          yield* sql`UPDATE inline_shell_runs SET status = 'error' WHERE sequence = ${row.sequence} AND ${activeThread(row.thread_id)}`;
          continue;
        }
        const now = yield* DateTime.now;
        yield* update({
          ...record,
          status: "interrupted",
          completedAt: DateTime.formatIso(now),
          durationMs: Math.max(0, DateTime.toEpochMillis(now) - Date.parse(record.startedAt)),
          error: "The server restarted before this run ended.",
        });
      }
      return rows.length;
    });
    const recover = () =>
      recoverBatch().pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not recover inline shell records").pipe(Effect.as(0)),
        ),
      );
    const deliver = <A, E, R>(
      input: InlineShellDelivery,
      send: (text: string) => Effect.Effect<A, E, R>,
    ) =>
      deliveries.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.compact) return yield* send(input.text);
          const delivered =
            yield* sql`SELECT delivery_id FROM inline_shell_delivery_events WHERE delivery_id = ${input.deliveryId}`.pipe(
              wrap(input.threadId),
            );
          if (delivered.length > 0) return yield* send(input.text);
          const rows =
            yield* sql<Row>`SELECT sequence, thread_id, record_json FROM inline_shell_runs WHERE thread_id = ${input.threadId} AND delivered_by IS NULL AND status <> 'running' ORDER BY sequence DESC LIMIT 64`.pipe(
              wrap(input.threadId),
            );
          const records: InlineShellRunRecord[] = [];
          for (const row of rows) {
            const record = yield* decodeRow(row);
            if (record !== null) records.push(record);
          }
          const counts = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM inline_shell_runs WHERE thread_id = ${input.threadId} AND delivered_by IS NULL AND status <> 'running'`.pipe(
            wrap(input.threadId),
          );
          const selected = selectInlineShellContext(records, counts[0]?.count ?? 0);
          // A repository orchestrator's next turn also carries one line about unread inbox events.
          const inbox = input.turnStart
            ? yield* pendingInboxNote(sql, input.threadId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Issue inbox note unavailable", { cause }).pipe(
                    Effect.as(NO_INBOX_NOTE),
                  ),
                ),
              )
            : NO_INBOX_NOTE;
          const result = yield* send(
            [inbox.text, selected.text, input.text].filter((part) => part !== "").join("\n\n"),
          );
          if (selected.ids.length > 0 || inbox.ids.length > 0) {
            const now = yield* DateTime.now;
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`INSERT INTO inline_shell_delivery_events (delivery_id, thread_id, run_id, attempt_id, provider_turn_id, message_id, record_ids_json, created_at) SELECT ${input.deliveryId}, ${input.threadId}, ${input.runId}, ${input.attemptId}, ${input.providerTurnId}, ${input.messageId}, ${encodeIds(selected.ids)}, ${DateTime.formatIso(now)} WHERE ${activeThread(input.threadId)} ON CONFLICT(delivery_id) DO NOTHING`;
                  yield* markInboxNoted(sql, inbox.ids, input.deliveryId);
                  if (selected.ids.length > 0)
                    yield* sql`UPDATE inline_shell_runs SET delivered_by = ${input.deliveryId} WHERE thread_id = ${input.threadId} AND run_id IN ${sql.in(selected.ids)} AND delivered_by IS NULL AND ${activeThread(input.threadId)}`;
                }),
              )
              .pipe(wrap(input.threadId));
          }
          return result;
        }),
      );
    return InlineShellStore.of({
      get: (threadId, runId) => get(threadId, runId).pipe(wrap(threadId)),
      latest: (input) => latest(input).pipe(wrap(input.threadId)),
      insert: (record) => insert(record).pipe(wrap(record.threadId)),
      update: (record) => update(record).pipe(wrap(record.threadId)),
      recover,
      deliver,
    });
  }),
);

/** Provider tests with no inline runs still exercise their existing start/steer behavior. */
export const layerEmpty = Layer.succeed(
  InlineShellStore,
  InlineShellStore.of({
    get: () => Effect.succeed(null),
    latest: () => Effect.succeed(null),
    insert: (record) => Effect.succeed(record),
    update: () => Effect.succeed(true),
    recover: () => Effect.succeed(0),
    deliver: (input, send) => send(input.text),
  }),
);
