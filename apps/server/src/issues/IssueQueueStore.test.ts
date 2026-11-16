import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { isIssueQueueNoticeRun } from "./IssueQueueStore.ts";

it.effect("looks up notice runs by delivery command without walking the thread event stream", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [command, type] of [
        ["notice", "issue.queue.deliver"],
        ["normal", "message.dispatch"],
      ]) {
        yield* sql`
          INSERT INTO orchestration_command_receipts
            (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
          VALUES (${command}, 'thread', 'root', '2026-11-16T00:00:00Z', 0, 'accepted', ${type})
        `;
      }
      for (const [version, command, run, type] of [
        [1, "notice", "notice-run", "run.created"],
        [2, "normal", "normal-run", "run.created"],
        [3, "notice", "updated-run", "run.updated"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events
            (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
             command_id, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${`event-${version}`}, 'thread', 'root', ${version}, ${type},
            '2026-11-16T00:00:00Z', ${command}, 'server', '{}', ${JSON.stringify({ runId: run })}, 2)
        `;
      }
      const connections: unknown[] = [];
      const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          connections.push(span.attributes.get("db.connection"));
          end(time, exit);
        };
        const [query, params] = statement.compile();
        return sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params).pipe(
          Effect.provideService(Statement.CurrentTransformer, undefined),
          Effect.tap((plan) =>
            Effect.sync(() => {
              assert.isTrue(
                plan.some((row) => row.detail.includes("idx_orch_command_receipts_aggregate")),
              );
              assert.isTrue(plan.some((row) => row.detail.includes("idx_orch_events_command_id")));
              assert.isFalse(
                plan.some((row) => row.detail.includes("idx_orch_events_stream_sequence")),
              );
            }),
          ),
          Effect.as(statement),
          Effect.orDie,
        );
      };
      const lookup = (thread: string, run: string) =>
        isIssueQueueNoticeRun(ThreadId.make(thread), RunId.make(run)).pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
      assert.isTrue(yield* lookup("root", "notice-run"));
      assert.isFalse(yield* lookup("root", "normal-run"));
      assert.isFalse(yield* lookup("root", "updated-run"));
      assert.isFalse(yield* lookup("other", "notice-run"));
      assert.deepEqual(connections, ["reader", "reader", "reader", "reader"]);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE orchestration_events SET metadata_json = '{"runId":"uncommitted"}'
          WHERE event_id = 'event-1'`;
          assert.isTrue(yield* lookup("root", "uncommitted"));
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(`${directory}/state.sqlite`)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
