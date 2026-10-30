// @effect-diagnostics nodeBuiltinImport:off - tests the filesystem free-space check.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import { enableIncrementalVacuum } from "./enableIncrementalVacuum.ts";

vi.mock("node:fs/promises", { spy: true });

it.effect("enables shrinking once, preserves data, and skips when disk space is insufficient", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "vacuum.sqlite");
    const db = new NodeSqlite.DatabaseSync(filename);
    db.exec(
      "CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES ('retained'); CREATE TABLE discard(value BLOB); INSERT INTO discard VALUES (zeroblob(1048576)); DROP TABLE discard;",
    );
    db.close();
    const before = Number((yield* fs.stat(filename)).size);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      using disk = vi.spyOn(NodeFSP, "statfs");
      disk.mockResolvedValueOnce({ bavail: before * 1.5, bsize: 1 } as Awaited<
        ReturnType<typeof NodeFSP.statfs>
      >);
      yield* enableIncrementalVacuum(filename);
      assert.equal((yield* sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 0);
      disk.mockRestore();
      yield* enableIncrementalVacuum(filename);
      assert.equal((yield* sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 2);
      assert.deepEqual(yield* sql`SELECT * FROM keep`, [{ value: "retained" }]);
      assert.isBelow(Number((yield* fs.stat(filename)).size), before);
      using vacuum = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare");
      yield* enableIncrementalVacuum(filename);
      assert.isFalse(vacuum.mock.calls.some(([query]) => query === "VACUUM"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["SQLITE_FULL", "SQLITE_IOERR"])(
  "continues startup after %s and leaves the database readable and writable",
  (code) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(yield* fs.makeTempDirectoryScoped(), "failed-vacuum.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE keep(value TEXT)`;
        yield* sql`INSERT INTO keep VALUES ('before')`;
        const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
        using _failure = vi
          .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
          .mockImplementation(function (this: NodeSqlite.DatabaseSync, query) {
            if (query === "VACUUM") throw Object.assign(new Error("disk full"), { code });
            return prepare.call(this, query);
          });
        yield* enableIncrementalVacuum(filename);
        yield* sql`INSERT INTO keep VALUES ('after')`;
        assert.deepEqual(yield* sql`SELECT value FROM keep ORDER BY rowid`, [
          { value: "before" },
          { value: "after" },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
