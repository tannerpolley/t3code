// @effect-diagnostics nodeBuiltinImport:off - filesystem free space has no Effect equivalent.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { rebuildMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
import * as SqlClient from "effect/sql/SqlClient";

export const enableIncrementalVacuum = Effect.fn("DatabaseMaintenance.enableIncrementalVacuum")(
  function* (databasePath: string) {
    const sql = yield* SqlClient.SqlClient;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum === 2) return;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const beforeBytes = (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0);
    const disk = yield* Effect.tryPromise(() => NodeFSP.statfs(databasePath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (disk === null) {
      yield* Effect.logWarning(
        "Skipping automatic database shrinking migration: free disk could not be checked",
      );
      return;
    }
    if (disk.bavail * disk.bsize < beforeBytes) {
      yield* Effect.logWarning(
        "Skipping automatic database shrinking migration: insufficient free disk",
        { beforeBytes, freeBytes: disk.bavail * disk.bsize },
      );
      return;
    }
    yield* Effect.log("Running database migrations", {
      migration: "incremental auto_vacuum",
      beforeBytes,
    });
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
    yield* sql`VACUUM`;
    yield* rebuildMessageSearch(sql);
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const after = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    yield* Effect.log("Migrations ran successfully", {
      migration: "incremental auto_vacuum",
      beforeBytes,
      afterBytes: (after[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0),
    });
  },
);
