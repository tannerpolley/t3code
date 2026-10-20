/**
 * The fork's own schema changes. They keep a ledger table of their own and run
 * after upstream's migrator, so upstream's migration ids never collide with
 * them. Add new fork migrations here, never to `migrationEntries`.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ProjectionMessagesLatestAssistant from "./ForkMigrations/001_ProjectionMessagesLatestAssistant.ts";
import ProjectionTurnItemCounts from "./ForkMigrations/002_ProjectionTurnItemCounts.ts";
import ThreadIssueWork from "./ForkMigrations/003_ThreadIssueWork.ts";
import RepositoryOrchestration from "./ForkMigrations/004_RepositoryOrchestration.ts";
import RepositoryScheduledWork from "./ForkMigrations/005_RepositoryScheduledWork.ts";
import IssueChanges from "./ForkMigrations/006_IssueChanges.ts";
import SidebarLayout from "./ForkMigrations/013_SidebarLayout.ts";
import IssueQueue from "./ForkMigrations/016_IssueQueue.ts";
import IssueInbox from "./ForkMigrations/015_IssueInbox.ts";
import UsageLimitSwitchRecovery from "./ForkMigrations/012_UsageLimitSwitchRecovery.ts";
import InlineShellRuns from "./ForkMigrations/010_InlineShellRuns.ts";
import ThreadUsageSummary from "./ForkMigrations/011_ThreadUsageSummary.ts";
import PendingRoutedRequests from "./ForkMigrations/007_PendingRoutedRequests.ts";
import EndedRunOpenTurnItems from "./ForkMigrations/014_EndedRunOpenTurnItems.ts";

import IssueThreadLinks from "../issues/IssueLinksMigration.ts";
import IssueRoadmapIndexes from "../issues/IssueRoadmapIndexesMigration.ts";

export const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

export const forkMigrationEntries = [
  [1, "ProjectionMessagesLatestAssistant", ProjectionMessagesLatestAssistant],
  [2, "ProjectionTurnItemCounts", ProjectionTurnItemCounts],
  [3, "ThreadIssueWork", ThreadIssueWork],
  [4, "RepositoryOrchestration", RepositoryOrchestration],
  [5, "RepositoryScheduledWork", RepositoryScheduledWork],
  [6, "IssueChanges", IssueChanges],
  [7, "PendingRoutedRequests", PendingRoutedRequests],
  [8, "IssueThreadLinks", IssueThreadLinks],
  [9, "IssueRoadmapIndexes", IssueRoadmapIndexes],
  [10, "InlineShellRuns", InlineShellRuns],
  [11, "ThreadUsageSummary", ThreadUsageSummary],
  [12, "UsageLimitSwitchRecovery", UsageLimitSwitchRecovery],
  [13, "SidebarLayout", SidebarLayout],
  [14, "EndedRunOpenTurnItems", EndedRunOpenTurnItems],
  [15, "IssueInbox", IssueInbox],
  [16, "IssueQueue", IssueQueue],
] as const;

// Fork builds before v2.11 recorded these in upstream's ledger as 57–62.
const UPSTREAM_LEDGER_OFFSET = 56;

/**
 * Moves fork rows out of upstream's ledger into the fork ledger in one
 * transaction, keeping their timestamps, so upstream's own 57+ migrations
 * apply. Any other row at 57+ next to them is an unknown collision and fails.
 */
export const moveForkMigrationsOutOfUpstreamLedger = Effect.fn(
  "moveForkMigrationsOutOfUpstreamLedger",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id > ${UPSTREAM_LEDGER_OFFSET} ORDER BY migration_id
      `;
      const isForkRow = (row: (typeof rows)[number]) =>
        forkMigrationEntries.some(
          ([id, name]) => id + UPSTREAM_LEDGER_OFFSET === row.migration_id && name === row.name,
        );
      if (!rows.some(isForkRow)) return [];
      const forkPrefix = rows.every(
        (row, index) => isForkRow(row) && row.migration_id === UPSTREAM_LEDGER_OFFSET + 1 + index,
      );
      const forkLedger = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
      `;
      const forkLedgerRows =
        forkLedger.length === 0
          ? []
          : yield* sql`SELECT migration_id FROM ${sql(FORK_MIGRATIONS_TABLE)}`;
      if (!forkPrefix || forkLedgerRows.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot move fork migrations out of the upstream ledger: unexpected history ${rows
            .map((row) => `${row.migration_id}:${row.name}`)
            .join(", ")}${forkLedgerRows.length > 0 ? " and a non-empty fork ledger" : ""}.`,
        });
      }
      // Same shape the migrator creates, so it reads this table as its own.
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      yield* sql`
        INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, created_at, name)
        SELECT migration_id - ${UPSTREAM_LEDGER_OFFSET}, created_at, name
        FROM effect_sql_migrations WHERE migration_id > ${UPSTREAM_LEDGER_OFFSET}
      `;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > ${UPSTREAM_LEDGER_OFFSET}`;
      return rows.map((row) => [row.migration_id - UPSTREAM_LEDGER_OFFSET, row.name] as const);
    }),
  );
});

const run = Migrator.make({});

/** Runs pending fork migrations, optionally only through `throughId`. */
export const runForkMigrations = (throughId?: number) =>
  run({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries
          .filter(([id]) => throughId === undefined || id <= throughId)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
