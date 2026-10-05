import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("backfills counts and keeps moves, streaming, rollback and rebuild atomic", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 57 });
    const insert = (id: string, threadId: string, runId: string | null) => sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, 1,
        'command_execution', 'running', '2026-10-05T00:00:00Z', '{}')
    `;
    yield* insert("a", "thread", "run");
    yield* insert("b", "thread", "run");
    yield* insert("c", "thread", null);
    yield* insert("d", "thread", "orphaned-run");
    yield* runMigrations({ toMigrationInclusive: 58 });
    const counts = sql<{ thread_id: string; run_id: string; item_count: number }>`
      SELECT thread_id, run_id, item_count
      FROM orchestration_v2_projection_turn_item_counts ORDER BY thread_id, run_id
    `.pipe(Effect.map((rows) => rows.map((row) => [row.thread_id, row.run_id, row.item_count])));
    assert.deepEqual(yield* counts, [
      ["thread", "", 1],
      ["thread", "orphaned-run", 1],
      ["thread", "run", 2],
    ]);
    // The projector's upsert assigns both keys on every streaming update.
    yield* sql`UPDATE orchestration_v2_projection_turn_items
      SET thread_id = 'thread', run_id = 'run', payload_json = '{"output":"stream"}'
      WHERE turn_item_id = 'a'`;
    assert.deepEqual(yield* counts, [
      ["thread", "", 1],
      ["thread", "orphaned-run", 1],
      ["thread", "run", 2],
    ]);
    yield* sql`UPDATE orchestration_v2_projection_turn_items
      SET thread_id = 'other', run_id = NULL WHERE turn_item_id = 'a'`;
    assert.deepEqual(yield* counts, [
      ["other", "", 1],
      ["thread", "", 1],
      ["thread", "orphaned-run", 1],
      ["thread", "run", 1],
    ]);
    yield* sql
      .withTransaction(
        sql`DELETE FROM orchestration_v2_projection_turn_items`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.exit);
    assert.deepEqual(yield* counts, [
      ["other", "", 1],
      ["thread", "", 1],
      ["thread", "orphaned-run", 1],
      ["thread", "run", 1],
    ]);
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
    assert.deepEqual(yield* counts, []);
    yield* insert("replayed", "thread", "run");
    yield* insert("replayed-runless", "thread", null);
    assert.deepEqual(yield* counts, [
      ["thread", "", 1],
      ["thread", "run", 1],
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
