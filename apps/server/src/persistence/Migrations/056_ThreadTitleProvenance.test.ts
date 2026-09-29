import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("056_ThreadTitleProvenance", (it) => {
  it.effect("backfills title ownership from the latest persisted title change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });

      const thread = (id: string, title: string) =>
        sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES (
            ${id}, 'project', ${title}, 'codex', 'full-access', 'default', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
            ${JSON.stringify({ id, title })}
          )
        `;
      const event = (
        id: string,
        sequence: number,
        type: "thread.created" | "thread.metadata-updated",
        title: string,
        commandId: string,
      ) =>
        sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json, application_event_version
          ) VALUES (
            ${`event:${id}:${sequence}`}, 'thread', ${id}, ${sequence}, ${type},
            '2026-01-01T00:00:00.000Z', ${commandId}, NULL, NULL, 'client',
            ${JSON.stringify({ id, title })}, '{}', 2
          )
        `;

      yield* thread("manual", "Manual title");
      yield* event("manual", 1, "thread.created", "Original title", "create:manual");
      yield* event("manual", 2, "thread.metadata-updated", "Manual title", "client:rename");

      yield* thread("generated", "Generated title");
      yield* event("generated", 1, "thread.created", "Original title", "create:generated");
      yield* event(
        "generated",
        2,
        "thread.metadata-updated",
        "Generated title",
        "server:title-refresh:generated:title-complete",
      );
      yield* event(
        "generated",
        3,
        "thread.metadata-updated",
        "Generated title",
        "client:branch-update",
      );

      yield* thread("unknown", "Imported title");
      yield* event("unknown", 1, "thread.created", "Imported title", "create:unknown");

      assert.deepStrictEqual(yield* runMigrations(), [[56, "ThreadTitleProvenance"]]);

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly title_source: string;
      }>`
        SELECT thread_id, json_extract(payload_json, '$.titleSource') AS title_source
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { thread_id: "generated", title_source: "generated" },
        { thread_id: "manual", title_source: "user" },
        { thread_id: "unknown", title_source: "user" },
      ]);
    }),
  );
});
