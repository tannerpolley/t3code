import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("indexes lineage and notice lookups using only projection state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 28 });
    yield* sql`INSERT INTO orchestration_v2_projection_issue_work_requests
      (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key,
        root_thread_id, payload_json, created_at, queue_state)
      VALUES ('notice', 'host', 'repo', 'owner/repo', 'issue', 1, 'notice', 'root',
        '{"noticeRunId":"run"}', '2026-11-09', 'queued')`;
    // A projection-only upgrade must work even if the event table cannot be read.
    yield* sql`DROP TABLE orchestration_events`;
    yield* runMigrations({ toForkMigrationInclusive: 29 });
    yield* runMigrations({ toForkMigrationInclusive: 29 });
    assert.deepEqual(
      yield* sql`SELECT notice_run_id FROM orchestration_v2_projection_issue_work_requests`,
      [{ notice_run_id: "run" }],
    );
    const notice = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT payload_json FROM orchestration_v2_projection_issue_work_requests
      WHERE root_thread_id = 'root' AND notice_run_id = 'run' AND queue_state = 'needs_attention'`;
    assert.isTrue(
      notice.some(
        (row) => row.detail.includes("SEARCH") && row.detail.includes("issue_queue_notice_run_idx"),
      ),
    );
    const lineage = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT count(*) FROM orchestration_v2_projection_threads thread
      WHERE json_extract(thread.payload_json, '$.lineage.rootThreadId') = 'root'`;
    assert.isTrue(
      lineage.some(
        (row) =>
          row.detail.includes("SEARCH") && row.detail.includes("issue_work_lineage_root_idx"),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
