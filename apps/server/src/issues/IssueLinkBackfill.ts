import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as TrackerIssueService from "../issue/IssueService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";

/** GitHub is the fork's only issue host; claims on other hosts stay claims without a link. */
const GITHUB = "github.com";

type Row = {
  readonly from_table: number;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly live: number;
  readonly linked: number;
  /** A claim's own link once existed in the thread's link history, so someone removed it. */
  readonly removed: number;
  readonly claim_json: string | null;
};

const decodeClaim = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadLinkedIssue));
const issueKey = (row: Pick<Row, "host" | "repository" | "number">) =>
  `${row.host.toLowerCase()}/${row.repository.toLowerCase()}#${row.number}`;

/**
 * Moves `issue_thread_links` rows and older GitHub claims onto `thread.issues[]` as commands, so
 * links survive a projection rebuild. Runs at each start until nothing is left; the command id
 * names the thread and issue, so a rerun replays its receipt.
 */
export const run = Effect.fn("IssueLinkBackfill.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const issues = yield* TrackerIssueService.IssueService;
  // `links` is a JSON array of thread.issues[] entries; the issue names columns in scope.
  const matches = (links: string, host: string, repository: string, number: string) => sql`
    EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${sql.unsafe(links)})
        THEN ${sql.unsafe(links)} ELSE '{}' END, '$.issues') link
      WHERE json_extract(link.value, '$.tracker') = 'github'
        AND lower(json_extract(link.value, '$.host')) = lower(${sql.unsafe(host)})
        AND lower(json_extract(link.value, '$.scope')) = lower(${sql.unsafe(repository)})
        AND json_extract(link.value, '$.key') = CAST(${sql.unsafe(number)} AS TEXT))`;
  const tableRows = yield* sql<Row>`
    SELECT 1 AS from_table, row.host, row.repository, row.issue_number AS number, row.thread_id,
      thread.project_id, thread.thread_id IS NOT NULL AND thread.deleted_at IS NULL AS live,
      COALESCE(${matches("thread.payload_json", "row.host", "row.repository", "row.issue_number")}, 0) AS linked,
      0 AS removed,
      CASE WHEN json_valid(thread.payload_json)
        THEN json_extract(thread.payload_json, '$.linkedIssue') END AS claim_json
    FROM issue_thread_links row
    LEFT JOIN orchestration_v2_projection_threads thread ON thread.thread_id = row.thread_id
  `.pipe(NodeSqliteClient.readOnly);
  // The cheap payload check runs first; only unlinked GitHub claims read their event history.
  const claims = yield* sql<Row>`
    WITH unlinked AS MATERIALIZED (
      SELECT claimed.thread_id, claimed.project_id,
        json_extract(claimed.payload_json, '$.linkedIssue.host') AS host,
        json_extract(claimed.payload_json, '$.linkedIssue.repository') AS repository,
        json_extract(claimed.payload_json, '$.linkedIssue.number') AS number,
        json_extract(claimed.payload_json, '$.linkedIssue') AS claim_json
      FROM orchestration_v2_projection_threads claimed
      WHERE claimed.deleted_at IS NULL
        AND lower(CASE WHEN json_valid(claimed.payload_json) THEN json_extract(claimed.payload_json, '$.linkedIssue.host') END) > ''
        AND NOT ${matches(
          "claimed.payload_json",
          "json_extract(claimed.payload_json, '$.linkedIssue.host')",
          "json_extract(claimed.payload_json, '$.linkedIssue.repository')",
          "json_extract(claimed.payload_json, '$.linkedIssue.number')",
        )}
    )
    SELECT 0 AS from_table, host, repository, number, thread_id, project_id, 1 AS live, 0 AS linked,
      CASE WHEN lower(host) <> ${GITHUB} THEN 0 ELSE EXISTS (
        SELECT 1 FROM orchestration_events event
        WHERE event.aggregate_kind = 'thread' AND event.stream_id = unlinked.thread_id
          AND event.event_type IN ('thread.created', 'thread.issue-synced')
          AND ${matches("event.payload_json", "unlinked.host", "unlinked.repository", "unlinked.number")}
      ) END AS removed,
      claim_json
    FROM unlinked
  `.pipe(NodeSqliteClient.readOnly);
  const removeRow = (row: Row) =>
    sql`DELETE FROM issue_thread_links WHERE host = ${row.host} AND repository = ${row.repository}
      AND issue_number = ${row.number} AND thread_id = ${row.thread_id}`;
  const counts = {
    linked: 0,
    rowsDone: 0,
    rowsDropped: 0,
    rowsKept: 0,
    otherHostRows: 0,
    otherHostClaims: 0,
  };
  const pending: Array<Row & { readonly projectId: ProjectId }> = [];
  for (const row of tableRows) {
    if (row.live === 0 || row.project_id === null) {
      yield* removeRow(row);
      counts.rowsDropped++;
    } else if (row.linked === 1) {
      yield* removeRow(row);
      counts.rowsDone++;
    } else if (row.host.toLowerCase() !== GITHUB) {
      yield* removeRow(row);
      counts.otherHostRows++;
    } else pending.push({ ...row, projectId: ProjectId.make(row.project_id) });
  }
  const fromTable = new Set(pending.map((row) => `${row.thread_id}:${issueKey(row)}`));
  for (const row of claims) {
    if (row.host.toLowerCase() !== GITHUB) counts.otherHostClaims++;
    else if (
      row.removed === 0 &&
      row.project_id !== null &&
      !fromTable.has(`${row.thread_id}:${issueKey(row)}`)
    )
      pending.push({ ...row, projectId: ProjectId.make(row.project_id) });
  }
  const named = new Map<string, { readonly title: string; readonly url: string }>();
  for (const row of pending) {
    const claim = Option.getOrUndefined(decodeClaim(row.claim_json));
    const title = claim?.title.trim();
    if (claim !== undefined && title && issueKey(claim) === issueKey(row))
      named.set(issueKey(row), { title, url: claim.url });
  }
  const unnamed = new Map<string, (typeof pending)[number]>();
  for (const row of pending) if (!named.has(issueKey(row))) unnamed.set(issueKey(row), row);
  const missing = new Set<string>();
  yield* Effect.forEach(
    unnamed,
    ([key, row]) =>
      issues
        .detail({
          projectId: row.projectId,
          tracker: IssueTrackerKind.make("github"),
          host: GITHUB,
          scope: row.repository,
          key: String(row.number),
        })
        .pipe(
          Effect.map((detail) => void named.set(key, { title: detail.title, url: detail.url })),
          Effect.catch((error) => {
            // A missing issue never appears; anything else may pass by the next start.
            if (error._tag === "IssueOperationError" && error.reason === "not-found")
              missing.add(key);
            return Effect.logWarning("issue link backfill could not read an issue title", {
              issue: key,
              reason: error.message,
            });
          }),
        ),
    { concurrency: 4, discard: true },
  );
  for (const row of pending) {
    const key = issueKey(row);
    const issue = named.get(key);
    if (issue === undefined) {
      if (row.from_table === 0) continue;
      if (missing.has(key)) {
        yield* removeRow(row);
        counts.rowsDropped++;
      } else counts.rowsKept++;
      continue;
    }
    const linked = yield* orchestrator
      .dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make(`fork:issue-link-backfill:${row.thread_id}:${key}`),
        threadId: ThreadId.make(row.thread_id),
        tracker: IssueTrackerKind.make("github"),
        host: GITHUB,
        scope: row.repository,
        key: String(row.number),
        projectId: row.projectId,
        url: issue.url,
        displayKey: `#${row.number}`,
        title: issue.title,
        source: "agent",
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("issue link backfill could not link a thread", {
            thread: row.thread_id,
            issue: key,
            reason: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!linked) {
      if (row.from_table === 1) counts.rowsKept++;
      continue;
    }
    counts.linked++;
    if (row.from_table === 1) {
      yield* removeRow(row);
      counts.rowsDone++;
    }
  }
  if (Object.entries(counts).some(([name, count]) => name !== "otherHostClaims" && count > 0))
    yield* Effect.logInfo("issue link backfill", counts);
  return counts;
});

export const layer = Layer.effectDiscard(
  forkParked(
    run().pipe(
      Effect.catchCause((cause) => Effect.logWarning("issue link backfill failed", { cause })),
    ),
  ),
);
