import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
  options: { readonly readerWorker?: boolean; readonly checkpointPauseLimit?: number } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(
      Effect.provide(
        // Backpressure tests assert that writes wait; a slow run must not reach the pause limit.
        SqliteClient.layer({
          filename,
          checkpointWorker: true,
          checkpointPauseLimit: 5 * 60_000,
          ...options,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const supportsNoopCheckpoint = (() => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  db.close();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 51);
})();

const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        let replies = 0;
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          if (++replies < 2) {
            // One checkpoint response may queue a coalesced follow-up behind the first barrier.
            // A second barrier observes that follow-up and makes the helper deterministic.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage("barrier");
            return;
          }
          worker.off("message", onReply);
          resolve();
        };
        worker.on("message", onReply);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

const waitForCheckpointMessage = (worker: NodeWorkerThreads.Worker, id: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "id" in message &&
        message.id === id
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const waitForTruncateCompletion = (worker: NodeWorkerThreads.Worker) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "truncateId" in message &&
        typeof message.truncateId === "number"
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const pauseCheckpointRequests = (worker: NodeWorkerThreads.Worker) => {
  const queued: Array<Parameters<typeof worker.postMessage>> = [];
  const send = worker.postMessage.bind(worker);
  const spy = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
    queued.push(args);
  });
  let restored = false;
  return {
    queued,
    sendNext() {
      const args = queued.shift();
      if (args !== undefined) send(...args);
      return args?.[0];
    },
    release() {
      if (restored) return;
      restored = true;
      spy.mockRestore();
      for (const args of queued.splice(0)) send(...args);
    },
  };
};

const blockCheckpointBehindReader = (
  sql: SqlClient.SqlClient,
  filename: string,
  worker: NodeWorkerThreads.Worker,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
    yield* sql.unsafe("CREATE TABLE IF NOT EXISTS entries(value INTEGER PRIMARY KEY)").unprepared;
    yield* sql.unsafe("CREATE TABLE IF NOT EXISTS pages(payload BLOB)").unprepared;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM entries").get();

    const checkpointRequests = pauseCheckpointRequests(worker);
    yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
    yield* sql.unsafe(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
      INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
    `).unprepared;

    const request = checkpointRequests.queued[0]?.[0];
    assert(typeof request === "object" && request !== null && "id" in request);
    const blocked = waitForCheckpointMessage(worker, (request as { readonly id: unknown }).id);
    checkpointRequests.sendNext();
    const state = yield* Effect.promise(() => blocked);
    assert.isTrue(state.blocked as boolean);
    assert.isAbove(state.log as number, 0);
    return { reader, checkpointRequests };
  });

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Yield one I/O turn so the real SQLite worker can receive its checkpoint message.
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect(
  "lets writes past a reader that holds the checkpoint back, then pauses them again",
  () => {
    const limit = 123_456;
    const pauses: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    // Only the pause limit is faked; every other timer runs for real.
    setTimeoutSpy.mockImplementation(((
      callback: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      // @effect-diagnostics-next-line globalTimers:off -- Stands in for the client's own wall-clock timer.
      if (delay !== limit) return realSetTimeout(callback, delay, ...args);
      pauses.push(callback);
      return { unref: () => {}, ref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => setTimeoutSpy.mockRestore()));
          const fs = yield* FileSystem.FileSystem;
          const worker = startedWorkers.at(-1)!;
          const first = yield* blockCheckpointBehindReader(sql, filename, worker);
          const held = yield* Effect.forkChild(sql`INSERT INTO entries VALUES (1)`, {
            startImmediately: true,
          });
          yield* eventLoopTurn;
          assert.isUndefined(held.pollUnsafe());
          assert.lengthOf(pauses, 1);
          // Another process can hold one snapshot for minutes; at the limit, writes go ahead.
          pauses[0]!();
          yield* Fiber.join(held);
          assert.equal(
            first.reader.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count,
            0,
          );

          const truncated = waitForTruncateCompletion(worker);
          first.checkpointRequests.release();
          first.reader.exec("ROLLBACK");
          yield* Effect.promise(() => truncated);
          assert.equal(Number((yield* fs.stat(`${filename}-wal`)).size), 0);
          // The next backlog needs its checkpoint request queued, so none may still be in flight.
          yield* checkpointWorkerReply(worker);

          // Once the WAL is bounded again, a new backlog pauses writes again.
          const second = yield* blockCheckpointBehindReader(sql, filename, worker);
          const paused = yield* Effect.forkChild(sql`INSERT INTO entries VALUES (2)`, {
            startImmediately: true,
          });
          yield* eventLoopTurn;
          assert.isUndefined(paused.pollUnsafe());
          assert.lengthOf(pauses, 2);
          second.checkpointRequests.release();
          second.reader.exec("ROLLBACK");
          yield* checkpointWorkerReply(worker);
          yield* Fiber.join(paused);
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM entries`, [{ count: 2 }]);
        }),
      { checkpointPauseLimit: limit },
    );
  },
  { skip: !supportsNoopCheckpoint },
);
