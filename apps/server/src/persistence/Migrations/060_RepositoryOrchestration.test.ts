import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const encodeOwnerPayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "backfills only an explicit repository owner and leaves ordinary old threads untouched",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      const ownerPayload = yield* encodeOwnerPayload({
        repositoryOrchestration: {
          host: "github.com",
          repository: "owner/repo",
          repositoryId: "repo-123",
          projectId: "project-1",
          workspace: "project",
          launchCommandId: "command-1",
          revision: 1,
          paused: false,
          workerLimit: 4,
          publishStatusComments: true,
          publishCloseoutComments: true,
        },
      });
      const insertThread = (threadId: string, payloadJson: string) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id, created_at,
        updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project-1', ${threadId}, 'codex', 'codex', 'yolo', 'default',
        NULL, '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', NULL, NULL, ${payloadJson}
      )
    `;
      yield* insertThread("root-thread", ownerPayload);
      yield* insertThread("old-thread", '{"title":"Old thread"}');

      yield* runMigrations({ toMigrationInclusive: 60 });
      const owners = yield* sql<{
        repository_id: string;
        root_thread_id: string;
        worker_limit: number;
      }>`
      SELECT repository_id, root_thread_id, worker_limit
      FROM orchestration_v2_projection_repository_orchestration
    `;
      assert.deepEqual(owners, [
        { repository_id: "repo-123", root_thread_id: "root-thread", worker_limit: 4 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
