import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { refreshThreadUsageSummary } from "../../orchestration-v2/ThreadUsageSummary.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_thread_usage (
    thread_id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  const threads = yield* sql<{
    readonly thread_id: string;
  }>`SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_turns`;
  for (const thread of threads) yield* refreshThreadUsageSummary(ThreadId.make(thread.thread_id));
});
