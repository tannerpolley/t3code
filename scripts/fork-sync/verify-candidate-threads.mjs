import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as ProjectionStore from "../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as Migrations from "../../apps/server/src/persistence/Migrations.ts";

export async function verifyCandidateThreads(db, ids) {
  // A second connection cannot see the uncommitted conversion. Run the actual startup
  // migrations and snapshot readers on this connection, then undo the migration preview.
  const execute = (sql, params, values = false) =>
    Effect.try({
      try: () => {
        const statement = db.prepare(sql);
        if (statement.columns().length) {
          statement.setReturnArrays(values);
          return statement.all(...params);
        }
        statement.run(...params);
        return [];
      },
      catch: (cause) => new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
    });
  const executeValues = (sql, params) => execute(sql, params, true);
  const connection = {
    execute: (sql, params) => execute(sql, params),
    executeUnprepared: (sql, params) => execute(sql, params),
    executeRaw: (sql, params) => execute(sql, params),
    executeValues,
    executeValuesUnprepared: executeValues,
    executeStream: () => Stream.die("The conversion verifier uses materialized SQLite reads"),
  };
  const client = Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      driver: "node:sqlite",
      compiler: Statement.makeCompilerSqlite(),
      acquirer: Effect.succeed(connection),
      spanAttributes: [],
      beginTransaction: "SAVEPOINT fresh_fork_reader",
      commit: "RELEASE fresh_fork_reader",
      rollback: "ROLLBACK TO fresh_fork_reader",
      releaseSavepoint: (name) => `RELEASE ${name}`,
    }),
  ).pipe(Layer.provide(Reactivity.layer));
  db.exec("SAVEPOINT fresh_fork_preview");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migrations.runMigrations();
        const store = yield* ProjectionStore.ProjectionStoreV2;
        for (const id of ids) {
          const threadId = ThreadId.make(id);
          yield* store.getThreadSnapshot(threadId);
          yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 20 });
        }
      }).pipe(
        Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(client))),
        Effect.provide(Logger.layer([])),
      ),
    );
  } finally {
    db.exec("ROLLBACK TO fresh_fork_preview; RELEASE fresh_fork_preview");
  }
}
