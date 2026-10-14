import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, forkMigrationEntries } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const forkLedger = forkMigrationEntries.map(([migration_id, name]) => ({ migration_id, name }));
const upstreamAfter56 = migrationManifest.filter(([id]) => id > 56);

// Fork builds before v2.11 recorded their migrations in upstream's ledger as 57+.
const seedForkBuild = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          forkMigrationEntries
            .slice(0, count)
            .map(([id, name, migration]) => [`${id + 56}_${name}`, migration]),
        ),
      ),
    });
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-05 00:00:' || migration_id WHERE migration_id > 56`;
  });

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
});

describe("fork migration ledger", () => {
  it.effect.each([6, 2])(
    "moves a fork build's %s migrations to the fork ledger, then applies upstream 57+",
    (count) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedForkBuild(count);
        const moved = yield* sql`
          SELECT migration_id - 56 AS migration_id, name, created_at
          FROM effect_sql_migrations WHERE migration_id > 56 ORDER BY migration_id
        `;

        assert.deepStrictEqual(yield* runMigrations(), upstreamAfter56);
        assert.deepStrictEqual(
          (yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
          `).map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        // Moved rows keep their original timestamps; the rest run fresh.
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name, created_at FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id <= ${count} ORDER BY migration_id`,
          moved,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`,
          forkLedger,
        );
        const tables = yield* tableNames;
        for (const table of [
          "scheduled_task_webhook_deliveries",
          "mcp_app_model_context",
          "pull_request_review_guides",
          "orchestration_v2_projection_issue_work",
          "issue_changes",
        ]) {
          assert.ok(tables.has(table), table);
        }

        const ledgers = yield* sql`
          SELECT 'upstream' AS ledger, * FROM effect_sql_migrations
          UNION ALL SELECT 'fork' AS ledger, * FROM ${sql(FORK_MIGRATIONS_TABLE)}
        `;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* sql`
            SELECT 'upstream' AS ledger, * FROM effect_sql_migrations
            UNION ALL SELECT 'fork' AS ledger, * FROM ${sql(FORK_MIGRATIONS_TABLE)}
          `,
          ledgers,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs fork migrations after upstream's on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`,
        forkLedger,
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      for (const column of ["webhook_token", "repository_target_json"]) {
        assert.ok(
          columns.some((row) => row.name === column),
          column,
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("applies usage migration 11 after inline shell migration 10 is already recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toForkMigrationInclusive: 10 });
      const before =
        yield* sql`SELECT migration_id, name, created_at FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`;
      assert.equal(before.at(-1)?.migration_id, 10);
      assert.equal(before.at(-1)?.name, "InlineShellRuns");
      assert.ok((yield* tableNames).has("inline_shell_runs"));
      assert.ok(!(yield* tableNames).has("orchestration_v2_projection_thread_usage"));
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name, created_at FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id <= 10 ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id > 10 ORDER BY migration_id`,
        [
          { migration_id: 11, name: "ThreadUsageSummary" },
          { migration_id: 12, name: "UsageLimitSwitchRecovery" },
          { migration_id: 13, name: "SidebarLayout" },
          { migration_id: 14, name: "EndedRunOpenTurnItems" },
        ],
      );
      assert.ok((yield* tableNames).has("orchestration_v2_projection_thread_usage"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    ["an unknown migration next to fork ones", [57, 58], "UnknownFork"],
    ["a gap in the fork ids", [57, 59], undefined],
  ] as const)("rejects %s without changing either ledger", ([, ids, unknownName]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      for (const id of ids) {
        const name =
          id === ids[1] && unknownName !== undefined
            ? unknownName
            : forkMigrationEntries[id - 57]![1];
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.ok(!(yield* tableNames).has(FORK_MIGRATIONS_TABLE));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
