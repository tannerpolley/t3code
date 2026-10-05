import * as NodeSqlite from "node:sqlite";
import { assert, it, vi } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const database = SqlitePersistenceMemory;
const layer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  TurnItemPositionStore.layer.pipe(Layer.provide(database)),
);
const threadId = ThreadId.make("thread:hot-paths");
const runId = RunId.make("run:hot-paths");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-05T00:01:00.000Z");
const item = {
  id: TurnItemId.make("item:hot-paths"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "Command",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "command_execution" as const,
  input: "echo done",
};

const seed = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make("event:hot-paths:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:hot-paths"),
      title: "History",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:hot-paths:run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1001,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      providerThreadId: null,
      userMessageId: MessageId.make("message:hot-paths"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:hot-paths:item"),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: item,
  });
});

it.effect("reads bounded rows when streaming and refreshing a shell with large history", () => {
  const reads: Array<{ sql: string; rows: number }> = [];
  let recording = false;
  const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: NodeSqlite.DatabaseSync,
    sql,
  ) {
    const statement = prepare.call(this, sql);
    const all = statement.all;
    statement.all = (...params) => {
      const rows = Reflect.apply(all, statement, params) as ReturnType<typeof all>;
      if (recording) reads.push({ sql, rows: rows.length });
      return rows;
    };
    return statement;
  });
  return Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const ordinal = yield* positions.normalize(item);
    // Old payloads remain valid JSON but fail today's item/run schemas. A
    // whole-history decode would fail as well as exceed the row budget.
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1000)
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
          status, requested_at, completed_at, payload_json)
      SELECT 'history:run:' || n, ${threadId}, n, ${instanceId}, ${instanceId}, NULL,
        'completed', ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}'
      FROM history
    `;
    yield* sql`
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1000)
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json)
      SELECT 'history:item:' || n, ${threadId}, 'history:run:' || n, NULL, NULL, NULL,
        NULL, n + 1, 'command_execution', 'completed', ${DateTime.formatIso(now)}, '{"obsolete":true}'
      FROM history
    `;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.futureField', json('{"keep":true}'))
      WHERE thread_id = ${threadId}`;

    recording = true;
    const normalized = yield* positions.normalize({
      ...item,
      status: "running",
      completedAt: null,
    });
    assert.equal(normalized.ordinal, ordinal.ordinal);
    yield* store.apply({
      id: EventId.make("event:hot-paths:stream"),
      type: "turn-item.updated",
      threadId,
      occurredAt: later,
      payload: {
        ...item,
        ordinal: normalized.ordinal,
        status: "running",
        completedAt: null,
        updatedAt: later,
        output: "new output",
      },
    });
    const shell = yield* store.getThreadShell(threadId);
    recording = false;
    assert.equal(shell?.itemCount, 1001);
    assert.equal(shell?.visibleItemCount, 1001);
    assert.isAtMost(
      reads.reduce((sum, read) => sum + read.rows, 0),
      4,
    );
    assert.isFalse(
      reads.some((read) =>
        /SELECT payload_json\s+FROM orchestration_v2_projection_threads/u.test(read.sql),
      ),
    );
    // Counts come from the small projection, never a scan of historic items.
    assert.isFalse(reads.some((read) => /COUNT\(\*\)/u.test(read.sql)));
    const [thread] = yield* sql<{ updated_at: string; timestamp: string; keep: number }>`
      SELECT updated_at, json_extract(payload_json, '$.updatedAt') AS timestamp,
        json_extract(payload_json, '$.futureField.keep') AS keep
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    assert.equal(thread?.updated_at, DateTime.formatIso(later));
    assert.equal(thread?.timestamp, DateTime.formatIso(later));
    assert.equal(thread?.keep, 1);
  }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => spy.mockRestore())));
});

it.effect(
  "allocates a new item once and reuses its durable ordinal without run reads or writes",
  () =>
    Effect.gen(function* () {
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const first = yield* positions.allocate({ threadId, turnItemId: item.id, runId });
      const statements: Array<string> = [];
      const record: Statement.Transformer = (statement) => {
        statements.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      const replayed = yield* positions
        .allocate({ threadId, turnItemId: item.id, runId, runOrdinal: 9999 })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.equal(replayed, first);
      assert.lengthOf(statements, 1);
      assert.match(statements[0]!, /WHERE thread_id = \? AND turn_item_id = \?/u);
      const second = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("next"),
        runId,
      });
      assert.equal(second, first + 1);
      const rows =
        yield* sql`SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}`;
      assert.lengthOf(rows, 2);
    }).pipe(Effect.provide(layer)),
);
