import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("requeues entries that a queue notice left needing attention", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 33 });
    const insert = (id: string, state: string, payload: object) =>
      sql`INSERT INTO orchestration_v2_projection_issue_work_requests
        (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key, root_thread_id, payload_json, created_at, queue_state, notice_run_id)
        VALUES (${id}, 'github.com', 'repo', 'owner/repo', ${id}, 1, ${id}, 'root', ${JSON.stringify({ requestId: id, state, ...payload })}, '2026-11-23', ${state}, ${"noticeRunId" in payload ? "run" : null})`;
    yield* insert("attention", "needs_attention", { notifiedAt: "2026-11-23" });
    yield* insert("noticed", "queued", { noticeRunId: "run", notifiedAt: "2026-11-23" });
    yield* insert("removed", "removed", {});
    yield* runMigrations({ toForkMigrationInclusive: 34 });
    assert.deepEqual(
      yield* sql`SELECT request_id, queue_state, notice_run_id, payload_json FROM orchestration_v2_projection_issue_work_requests ORDER BY request_id`,
      [
        {
          request_id: "attention",
          queue_state: "queued",
          notice_run_id: null,
          payload_json: '{"requestId":"attention","state":"queued"}',
        },
        {
          request_id: "noticed",
          queue_state: "queued",
          notice_run_id: null,
          payload_json: '{"requestId":"noticed","state":"queued"}',
        },
        {
          request_id: "removed",
          queue_state: "removed",
          notice_run_id: null,
          payload_json: '{"requestId":"removed","state":"removed"}',
        },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
