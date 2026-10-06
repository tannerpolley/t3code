import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadLinkedIssue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const encodeIssuePayload = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ linkedIssue: ThreadLinkedIssue })),
);

it.effect("backfills only explicit issue bindings and reruns without fabricating old links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 58 });
    const issue = {
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:8",
      id: "issue:8",
      nodeId: "node:8",
      number: 8,
      url: "https://github.com/tannerpolley/t3code/issues/8",
      title: "Single issue",
    };
    const insert = (threadId: string, payload: string) => sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
         interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
         deleted_at, payload_json)
      VALUES (${threadId}, 'project', '#8 Single issue', 'codex', 'codex', 'full-access',
        'default', NULL, '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', NULL, NULL, ${payload})
    `;
    yield* insert("old-unlinked", '{"title":"#8 Single issue"}');
    yield* insert("explicit", yield* encodeIssuePayload({ linkedIssue: issue }));
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* runMigrations({ toMigrationInclusive: 59 });
    const work = yield* sql<{
      owner_thread_id: string;
      issue_id: string;
      status_comment_id: string | null;
    }>`
      SELECT owner_thread_id, issue_id, status_comment_id FROM orchestration_v2_projection_issue_work
    `;
    assert.deepEqual(work, [
      { owner_thread_id: "explicit", issue_id: "issue:8", status_comment_id: null },
    ]);
    const old = yield* sql<{ linked_issue: string | null }>`
      SELECT json_extract(payload_json, '$.linkedIssue') AS linked_issue
      FROM orchestration_v2_projection_threads WHERE thread_id = 'old-unlinked'
    `;
    assert.isNull(old[0]?.linked_issue);
    assert.lengthOf(
      yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`,
      0,
    );
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_projection_issue_work_requests`, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
