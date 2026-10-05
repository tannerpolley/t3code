#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Argument, Command, Flag } from "effect/unstable/cli";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../src/serverRuntimeState.ts";

export const SqliteStateOperation = Schema.Literals(["query", "exec", "compact"]);
export type SqliteStateOperation = typeof SqliteStateOperation.Type;

export class SqliteStateMultipleSqlSourcesError extends Schema.TaggedError<SqliteStateMultipleSqlSourcesError>()(
  "SqliteStateMultipleSqlSourcesError",
  {},
) {
  override get message(): string {
    return "Provide only one of --sql or --file.";
  }
}

export class SqliteStateMissingSqlSourceError extends Schema.TaggedError<SqliteStateMissingSqlSourceError>()(
  "SqliteStateMissingSqlSourceError",
  {},
) {
  override get message(): string {
    return "Provide one of --sql or --file.";
  }
}

export class SqliteStateEmptySqlError extends Schema.TaggedError<SqliteStateEmptySqlError>()(
  "SqliteStateEmptySqlError",
  {},
) {
  override get message(): string {
    return "SQL input is empty.";
  }
}

export class SqliteStateDatabaseMissingError extends Schema.TaggedError<SqliteStateDatabaseMissingError>()(
  "SqliteStateDatabaseMissingError",
  {
    databasePath: Schema.String,
  },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start T3 once to run migrations.`;
  }
}

export class SqliteStateSharedHomeMutationError extends Schema.TaggedError<SqliteStateSharedHomeMutationError>()(
  "SqliteStateSharedHomeMutationError",
  {},
) {
  override get message(): string {
    return "Refusing to mutate live T3 userdata. Stop its server and use a copied database under an isolated --base-dir.";
  }
}

export class SqliteStateUnexpectedSqlSourceError extends Schema.TaggedError<SqliteStateUnexpectedSqlSourceError>()(
  "SqliteStateUnexpectedSqlSourceError",
  {},
) {
  override get message(): string {
    return "The compact operation does not accept --sql or --file.";
  }
}

export class SqliteStateCompactionVerificationError extends Schema.TaggedError<SqliteStateCompactionVerificationError>()(
  "SqliteStateCompactionVerificationError",
  {
    phase: Schema.Literals(["before", "after"]),
    expectedSequence: Schema.Number,
    projectionSequence: Schema.Number,
  },
) {
  override get message(): string {
    return `Projection verification failed ${this.phase} compaction (event sequence ${this.expectedSequence}, projection sequence ${this.projectionSequence}).`;
  }
}

export class SqliteStateSqlFileError extends Schema.TaggedError<SqliteStateSqlFileError>()(
  "SqliteStateSqlFileError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read SQL from '${this.filePath}'.`;
  }
}

export class SqliteStateDatabaseError extends Schema.TaggedError<SqliteStateDatabaseError>()(
  "SqliteStateDatabaseError",
  {
    operation: SqliteStateOperation,
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} SQLite database at '${this.databasePath}'.`;
  }
}

const isCompactionVerificationError = Schema.is(SqliteStateCompactionVerificationError);
const isDatabaseError = Schema.is(SqliteStateDatabaseError);

const SqliteStateValue = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Array(Schema.Number),
]);
const SqliteStateRow = Schema.Record(Schema.String, SqliteStateValue);
const SqliteStateQueryResult = Schema.Struct({
  operation: Schema.Literal("query"),
  database: Schema.String,
  rows: Schema.Array(SqliteStateRow),
});
const SqliteStateExecResult = Schema.Struct({
  operation: Schema.Literal("exec"),
  database: Schema.String,
  backup: Schema.String,
});
const SqliteStateCompactionVerification = Schema.Struct({
  schemaVersion: Schema.Number,
  expectedSequence: Schema.Number,
  projectionSequence: Schema.Number,
});
const SqliteStateCompactResult = Schema.Struct({
  operation: Schema.Literal("compact"),
  database: Schema.String,
  before: SqliteStateCompactionVerification,
  deletedEventCount: Schema.Number,
  deletedReceiptCount: Schema.Number,
  reclaimableBytes: Schema.Number,
  after: SqliteStateCompactionVerification,
  databaseBytes: Schema.Number,
});
const SqliteStateResult = Schema.Union([
  SqliteStateQueryResult,
  SqliteStateExecResult,
  SqliteStateCompactResult,
]);
const encodeSqliteStateResult = Schema.encodeEffect(fromJsonStringPretty(SqliteStateResult));

export type SqliteStateResult = typeof SqliteStateResult.Type;

type RawSqliteValue = null | string | number | bigint | Uint8Array;
type RawSqliteRow = Readonly<Record<string, RawSqliteValue>>;

export interface RunSqliteStateInput {
  readonly operation: SqliteStateOperation;
  readonly baseDir: string;
  readonly sql?: string | undefined;
  readonly file?: string | undefined;
}

export interface RunSqliteStateOptions {
  readonly sharedHome?: string | undefined;
}

const ensureCopiedDatabaseIsNotLive = Effect.fn("ensureCopiedDatabaseIsNotLive")(function* (
  databasePath: string,
  options: RunSqliteStateOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalDatabasePath = yield* fs.realPath(databasePath);
  const runtimeState = yield* readPersistedServerRuntimeState(
    path.join(path.dirname(databasePath), "server-runtime.json"),
  );
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new SqliteStateSharedHomeMutationError();
  }

  const liveHomes = new Set([
    path.join(NodeOS.homedir(), ".t3"),
    ...(process.env.T3CODE_HOME?.trim() ? [process.env.T3CODE_HOME.trim()] : []),
    ...(options.sharedHome === undefined ? [] : [options.sharedHome]),
  ]);

  for (const liveHome of liveHomes) {
    const resolvedHome = path.resolve(liveHome);
    const canonicalHome = yield* fs
      .realPath(resolvedHome)
      .pipe(Effect.orElseSucceed(() => resolvedHome));
    for (const liveDatabasePath of [
      path.join(canonicalHome, "userdata", "statev2.sqlite"),
      path.join(canonicalHome, "dev", "userdata", "statev2.sqlite"),
    ]) {
      const canonicalLiveDatabasePath = yield* fs
        .realPath(liveDatabasePath)
        .pipe(Effect.orElseSucceed(() => liveDatabasePath));
      if (canonicalDatabasePath === canonicalLiveDatabasePath) {
        return yield* new SqliteStateSharedHomeMutationError();
      }
    }
  }
});

const compactCopiedDatabase = Effect.fn("compactCopiedSqliteDatabase")(function* (
  databasePath: string,
  options: RunSqliteStateOptions,
) {
  yield* ensureCopiedDatabaseIsNotLive(databasePath, options);

  const databaseLayer = NodeSqliteClient.layer({ filename: databasePath });
  const storesLayer = Layer.mergeAll(
    databaseLayer,
    EventStore.layer.pipe(Layer.provide(databaseLayer)),
    ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  );
  const maintenanceLayer = ProjectionMaintenance.layer.pipe(Layer.provide(storesLayer));
  const compactLayer = Layer.merge(storesLayer, maintenanceLayer);

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* sql`PRAGMA busy_timeout = 5000`;

    const before = yield* maintenance.verify;
    if (!before.valid) {
      return yield* new SqliteStateCompactionVerificationError({
        phase: "before",
        expectedSequence: before.expectedSequence,
        projectionSequence: before.projectionSequence,
      });
    }

    const summary = yield* maintenance.compactEventStore;
    yield* sql`VACUUM`;
    const checkpoint = yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`;
    if ((checkpoint[0]?.busy ?? 0) !== 0) {
      return yield* new SqliteStateDatabaseError({
        operation: "compact",
        databasePath,
        cause: "SQLite remained busy while checkpointing the compacted copy.",
      });
    }

    const after = yield* maintenance.verify;
    if (!after.valid) {
      return yield* new SqliteStateCompactionVerificationError({
        phase: "after",
        expectedSequence: after.expectedSequence,
        projectionSequence: after.projectionSequence,
      });
    }
    const pageCount = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const pageSize = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;

    return {
      operation: "compact",
      database: databasePath,
      before: {
        schemaVersion: before.schemaVersion,
        expectedSequence: before.expectedSequence,
        projectionSequence: before.projectionSequence,
      },
      deletedEventCount: summary.deletedEventCount,
      deletedReceiptCount: summary.deletedReceiptCount,
      reclaimableBytes: summary.reclaimableBytes,
      after: {
        schemaVersion: after.schemaVersion,
        expectedSequence: after.expectedSequence,
        projectionSequence: after.projectionSequence,
      },
      databaseBytes: (pageCount[0]?.page_count ?? 0) * (pageSize[0]?.page_size ?? 0),
    } as const;
  });

  return yield* program.pipe(
    Effect.provide(compactLayer),
    Effect.mapError((cause) =>
      isCompactionVerificationError(cause) || isDatabaseError(cause)
        ? cause
        : new SqliteStateDatabaseError({ operation: "compact", databasePath, cause }),
    ),
  );
});

const resolveSqlSource = Effect.fn("resolveSqliteStateSqlSource")(function* (
  sql: string | undefined,
  file: string | undefined,
) {
  if (sql !== undefined && file !== undefined) {
    return yield* new SqliteStateMultipleSqlSourcesError();
  }
  if (sql === undefined && file === undefined) {
    return yield* new SqliteStateMissingSqlSourceError();
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let source: string;
  if (sql !== undefined) {
    source = sql;
  } else {
    const filePath = path.resolve(file as string);
    source = yield* fs
      .readFileString(filePath)
      .pipe(Effect.mapError((cause) => new SqliteStateSqlFileError({ filePath, cause })));
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return yield* new SqliteStateEmptySqlError();
  }
  return trimmed;
});

function normalizeSqliteValue(value: RawSqliteValue): typeof SqliteStateValue.Type {
  if (typeof value === "bigint") {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) ? numericValue : value.toString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  return value;
}

function normalizeSqliteRow(row: RawSqliteRow): typeof SqliteStateRow.Type {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)]),
  );
}

export const runSqliteState = Effect.fn("runSqliteState")(function* (
  input: RunSqliteStateInput,
  options: RunSqliteStateOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.resolve(input.baseDir);
  const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");

  if (input.operation === "compact") {
    if (input.sql !== undefined || input.file !== undefined) {
      return yield* new SqliteStateUnexpectedSqlSourceError();
    }
    if (!(yield* fs.exists(databasePath))) {
      return yield* new SqliteStateDatabaseMissingError({ databasePath });
    }
    return yield* compactCopiedDatabase(databasePath, options);
  }

  const source = yield* resolveSqlSource(input.sql, input.file);

  if (!(yield* fs.exists(databasePath))) {
    return yield* new SqliteStateDatabaseMissingError({ databasePath });
  }
  if (input.operation === "exec") {
    yield* ensureCopiedDatabaseIsNotLive(databasePath, options);
  }

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;

    if (input.operation === "query") {
      const rows = yield* sql.unsafe<RawSqliteRow>(source).unprepared.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        Effect.map((rows) => rows.map(normalizeSqliteRow)),
      );
      return {
        operation: "query",
        database: databasePath,
        rows,
      } as const;
    }

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backupPath = `${databasePath}.backup-${timestamp}`;
    yield* sql`VACUUM INTO ${backupPath}`;
    yield* fs.chmod(backupPath, 0o600);
    yield* sql.withTransaction(sql.unsafe(source).unprepared);

    return {
      operation: "exec",
      database: databasePath,
      backup: backupPath,
    } as const;
  });

  return yield* program.pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: databasePath,
        readonly: input.operation === "query",
      }),
    ),
    Effect.mapError(
      (cause) =>
        new SqliteStateDatabaseError({
          operation: input.operation,
          databasePath,
          cause,
        }),
    ),
  );
});

const t3SqliteStateCommand = Command.make(
  "t3-sqlite-state",
  {
    operation: Argument.Literals("operation", SqliteStateOperation.literals).pipe(
      Argument.withDescription("Query, seed, or compact an isolated T3 SQLite database."),
    ),
    baseDir: Flag.String("base-dir").pipe(
      Flag.withDescription("Explicit T3 base directory containing userdata/statev2.sqlite."),
    ),
    sql: Flag.String("sql").pipe(
      Flag.optional,
      Flag.withDescription("SQL source supplied directly on the command line."),
    ),
    file: Flag.String("file").pipe(
      Flag.optional,
      Flag.withDescription("Path to a SQL source file."),
    ),
  },
  ({ operation, baseDir, sql, file }) =>
    runSqliteState({
      operation,
      baseDir,
      sql: Option.getOrUndefined(sql),
      file: Option.getOrUndefined(file),
    }).pipe(Effect.flatMap(encodeSqliteStateResult), Effect.flatMap(Console.log)),
).pipe(
  Command.withDescription(
    "Inspect or seed an isolated T3 SQLite database; compact operates on a copied offline database.",
  ),
);

if (import.meta.main) {
  Command.run(t3SqliteStateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
