import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

import { keepIssueWorktree } from "../issues/issueThreadRetention.ts";

const IDLE_DAYS = 7;

/** Archived threads and subagent threads whose parent is idle, untouched since `cutoff`. */
export const findIdleThreads = Effect.fn("IdleThreadCleanup.findIdleThreads")(function* (
  cutoff: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const active = sql.in(["queued", "preparing", "starting", "running", "waiting"]);
  const rows = yield* sql<{
    readonly thread_id: ThreadId;
    readonly payload_json: string;
    readonly archived_at: string | null;
  }>`
    SELECT thread.thread_id, thread.payload_json, thread.archived_at FROM orchestration_v2_projection_threads AS thread
    WHERE thread.deleted_at IS NULL
      AND thread.updated_at <= ${cutoff}
      AND (
        thread.archived_at IS NOT NULL
        OR (
          json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id = json_extract(thread.payload_json, '$.lineage.parentThreadId')
              AND run.status IN ${active}
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = thread.thread_id AND run.status IN ${active}
      )
    ORDER BY thread.updated_at
  `.pipe(NodeSqliteClient.readOnly);
  return rows
    .filter((row) => row.archived_at !== null || !keepIssueWorktree(JSON.parse(row.payload_json)))
    .map((row) => row.thread_id);
});

/** Deletes idle threads once a day; the history purge then removes their data. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;

  const sweep = Effect.fn("IdleThreadCleanup.sweep")(function* () {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: IDLE_DAYS }));
    const threadIds = yield* findIdleThreads(cutoff).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    let deleted = 0;
    for (const threadId of threadIds) {
      const removed = yield* orchestrator
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:idle-cleanup:${threadId}`),
          threadId,
        })
        .pipe(
          Effect.as(true),
          // A registered repository root refuses deletion; it stays.
          Effect.catch((cause) =>
            Effect.logDebug("idle thread cleanup kept a thread", { threadId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (removed) deleted++;
      // ponytail: fixed pacing keeps a first sweep of thousands from crowding user commands.
      yield* Effect.sleep("100 millis");
    }
    if (deleted > 0) yield* Effect.logInfo("Deleted idle threads", { deleted });
  });

  const start = Effect.fn("IdleThreadCleanup.start")(function* () {
    yield* forkParked(
      Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          sweep().pipe(
            Effect.catch((cause) => Effect.logWarning("idle thread cleanup failed", { cause })),
            Effect.repeat(Schedule.spaced("1 day")),
          ),
        ),
      ),
    );
  });
  return { start };
});
