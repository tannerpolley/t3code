import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "adds a queue to the request ledger without changing existing starts and permits one pending entry per issue",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 15 });
      yield* sql`INSERT INTO orchestration_v2_projection_issue_work_requests
    (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key, root_thread_id, payload_json, created_at)
    VALUES ('start', 'github.com', 'repo', 'owner/repo', 'one', 1, 'attempt', 'root', '{"requestId":"start"}', '2026-10-20')`;
      yield* runMigrations({ toForkMigrationInclusive: 16 });
      yield* runMigrations({ toForkMigrationInclusive: 16 });
      assert.deepEqual(
        yield* sql`SELECT request_id, payload_json, queue_state FROM orchestration_v2_projection_issue_work_requests`,
        [{ request_id: "start", payload_json: '{"requestId":"start"}', queue_state: null }],
      );
      const insert = (id: string) => sql`INSERT INTO orchestration_v2_projection_issue_work_requests
    (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key, root_thread_id, payload_json, created_at, queue_state)
    VALUES (${id}, 'github.com', 'repo', 'owner/repo', 'one', 1, ${id}, 'mailbox', '{}', '2026-10-20', 'queued')`;
      yield* insert("queue-one");
      assert.isTrue((yield* insert("duplicate").pipe(Effect.result))._tag === "Failure");
      yield* sql`UPDATE orchestration_v2_projection_issue_work_requests SET queue_state = 'needs_attention' WHERE request_id = 'queue-one'`;
      assert.isTrue((yield* insert("duplicate-attention").pipe(Effect.result))._tag === "Failure");
      yield* sql`UPDATE orchestration_v2_projection_issue_work_requests SET queue_state = 'removed' WHERE request_id = 'queue-one'`;
      yield* insert("queue-again");
      assert.deepEqual(
        yield* sql`SELECT request_id FROM orchestration_v2_projection_issue_work_requests WHERE queue_state = 'queued'`,
        [{ request_id: "queue-again" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
