import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../src/persistence/Migrations.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "../src/orchestration-v2/ProjectionStore.ts";
import { runSqliteState } from "./t3-sqlite-state.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const createFixtureDatabase = Effect.fn("createSqliteStateFixtureDatabase")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`INSERT INTO fixtures (id, label) VALUES (1, 'existing')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

it.layer(NodeServices.layer)("t3-sqlite-state", (it) => {
  it.effect("reports each invalid SQL source with a specific error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-input-" });

      const multipleSources = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT 1",
        file: "fixture.sql",
      }).pipe(Effect.flip);
      assert.equal(multipleSources._tag, "SqliteStateMultipleSqlSourcesError");
      assert.equal(multipleSources.message, "Provide only one of --sql or --file.");

      const missingSource = yield* runSqliteState({ operation: "query", baseDir }).pipe(
        Effect.flip,
      );
      assert.equal(missingSource._tag, "SqliteStateMissingSqlSourceError");
      assert.equal(missingSource.message, "Provide one of --sql or --file.");

      const emptySql = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "   ",
      }).pipe(Effect.flip);
      assert.equal(emptySql._tag, "SqliteStateEmptySqlError");

      const compactWithSql = yield* runSqliteState({
        operation: "compact",
        baseDir,
        sql: "SELECT 1",
      }).pipe(Effect.flip);
      assert.equal(compactWithSql._tag, "SqliteStateUnexpectedSqlSourceError");
      assert.equal(emptySql.message, "SQL input is empty.");
    }),
  );

  it.effect("queries an isolated database through Effect SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-query-" });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT id, label FROM fixtures",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ id: 1, label: "existing" }]);
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "backs up isolated state before writes and refuses the shared home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-exec-" });
        yield* createFixtureDatabase(baseDir);

        const mutation = yield* runSqliteState({
          operation: "exec",
          baseDir,
          sql: "INSERT INTO fixtures (id, label) VALUES (2, 'seeded')",
        });
        assert.equal(mutation.operation, "exec");
        if (mutation.operation === "exec" && (yield* HostProcessPlatform) !== "win32") {
          // NTFS has no POSIX mode bits to report.
          assert.equal((yield* fs.stat(mutation.backup)).mode & 0o777, 0o600);
        }

        const error = yield* runSqliteState(
          {
            operation: "exec",
            baseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");

        const originalT3CodeHome = process.env.T3CODE_HOME;
        process.env.T3CODE_HOME = `${baseDir}-other-home`;
        let envOverrideError: { readonly _tag: string } | undefined;
        try {
          envOverrideError = yield* runSqliteState(
            {
              operation: "exec",
              baseDir,
              sql: "DELETE FROM fixtures",
            },
            { sharedHome: baseDir },
          ).pipe(Effect.flip);
        } finally {
          if (originalT3CodeHome === undefined) delete process.env.T3CODE_HOME;
          else process.env.T3CODE_HOME = originalT3CodeHome;
        }
        assert.equal(envOverrideError?._tag, "SqliteStateSharedHomeMutationError");

        const compactError = yield* runSqliteState(
          {
            operation: "compact",
            baseDir,
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(compactError._tag, "SqliteStateSharedHomeMutationError");

        const aliasParent = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-sqlite-state-alias-",
        });
        const aliasBaseDir = path.join(aliasParent, "shared-home-alias");
        yield* fs.symlink(baseDir, aliasBaseDir);
        const aliasError = yield* runSqliteState(
          {
            operation: "exec",
            baseDir: aliasBaseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(aliasError._tag, "SqliteStateSharedHomeMutationError");

        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "server-runtime.json"),
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: 12345,
            origin: "http://127.0.0.1:12345",
            startedAt: "2026-10-02T00:00:00.000Z",
          }),
        );
        const runningServerError = yield* runSqliteState({
          operation: "compact",
          baseDir,
        }).pipe(Effect.flip);
        assert.equal(runningServerError._tag, "SqliteStateSharedHomeMutationError");
      }),
  );

  it.effect("compacts and vacuums an explicitly selected copied database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-state-compact-" });
      const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      const timestamp = "2026-10-02T00:00:00.000Z";
      const payload = JSON.stringify({ body: "x".repeat(10 * 1024) });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`
          WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 200
          )
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          )
          SELECT
            'event:compact-imported:' || n, 'thread', 'thread:compact-imported', n,
            'thread.message-appended', ${timestamp}, 'user', ${payload}, '{}', 1
          FROM history
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            'event:compact-pending', 'thread', 'thread:compact-pending', 1,
            'thread.message-appended', ${timestamp}, 'user', '{}', '{}', 1
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
            imported_message_count, last_error
          ) VALUES (
            'thread:compact-imported', ${timestamp}, ${timestamp}, ${timestamp}, 200, NULL
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_metadata (
            projection_name, schema_version, last_sequence, updated_at
          ) VALUES (
            'thread-projections', ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
            0, 'test'
          )
          ON CONFLICT(projection_name) DO UPDATE SET
            schema_version = excluded.schema_version,
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

      const beforeBytes = (yield* fs.stat(databasePath)).size;
      const result = yield* runSqliteState({ operation: "compact", baseDir });
      assert.equal(result.operation, "compact");
      if (result.operation === "compact") {
        assert.equal(result.before.expectedSequence, 0);
        assert.equal(result.deletedEventCount, 200);
        assert.equal(result.after.expectedSequence, 0);
        assert.isTrue(result.databaseBytes > 0);
        assert.isBelow((yield* fs.stat(databasePath)).size, beforeBytes);
      }
    }),
  );
});
