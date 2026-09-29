import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("056_ThreadTitleProvenance", (it) => {
  it.effect("marks only client renames and V1 imports as user titles", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });

      const thread = (id: string, title: string, historyOrigin?: string) =>
        sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES (
            ${id}, 'project', ${title}, 'codex', 'full-access', 'default', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
            ${JSON.stringify({ id, title, historyOrigin })}
          )
        `;
      const event = (
        id: string,
        sequence: number,
        title: string,
        command: { readonly id: string; readonly type: string },
      ) =>
        Effect.all([
          sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json, application_event_version
            ) VALUES (
              ${`event:${id}:${sequence}`}, 'thread', ${id}, ${sequence},
              ${sequence === 1 ? "thread.created" : "thread.metadata-updated"},
              '2026-01-01T00:00:00.000Z', ${command.id}, NULL, NULL, 'server',
              ${JSON.stringify({ id, title })}, '{}', 2
            )
          `,
          sql`
            INSERT INTO orchestration_command_receipts (
              command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
              status, error, command_type
            ) VALUES (
              ${command.id}, 'thread', ${id}, '2026-01-01T00:00:00.000Z', ${sequence},
              'accepted', NULL, ${command.type}
            )
          `,
        ]);
      const created = (id: string, title: string) =>
        event(id, 1, title, { id: `create:${id}`, type: "thread.create" });

      // A person renamed it in a client.
      yield* thread("client-rename", "Typed title");
      yield* created("client-rename", "Launch title");
      yield* event("client-rename", 2, "Typed title", {
        id: "0b8d5c1e-rename",
        type: "thread.metadata.update",
      });
      // An agent renamed it through t3_thread_update.
      yield* thread("agent-rename", "Agent title");
      yield* created("agent-rename", "Launch title");
      yield* event("agent-rename", 2, "Agent title", {
        id: "command:mcp:session:thread-update:agent-rename:rename:1",
        type: "thread.metadata.update",
      });
      // Regenerated after a rename; a later event that keeps the title changes nothing.
      yield* thread("regenerated", "Generated title");
      yield* created("regenerated", "Launch title");
      yield* event("regenerated", 2, "Typed title", {
        id: "rename",
        type: "thread.metadata.update",
      });
      yield* event("regenerated", 3, "Generated title", {
        id: "regenerate:title-complete",
        type: "thread.title.regeneration.complete",
      });
      yield* event("regenerated", 4, "Generated title", {
        id: "branch",
        type: "thread.metadata.update",
      });
      // Titled at launch, by an agent or the first message, and never renamed.
      yield* thread("launch", "Launch title");
      yield* created("launch", "Launch title");
      // Imported from V1, which kept no record of who chose the title.
      yield* thread("v1-import", "Imported title", "v1_import");
      yield* created("v1-import", "Imported title");

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 56 }), [
        [56, "ThreadTitleProvenance"],
      ]);

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly title_source: string;
      }>`
        SELECT thread_id, json_extract(payload_json, '$.titleSource') AS title_source
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { thread_id: "agent-rename", title_source: "generated" },
        { thread_id: "client-rename", title_source: "user" },
        { thread_id: "launch", title_source: "generated" },
        { thread_id: "regenerated", title_source: "generated" },
        { thread_id: "v1-import", title_source: "user" },
      ]);
    }),
  );
});
