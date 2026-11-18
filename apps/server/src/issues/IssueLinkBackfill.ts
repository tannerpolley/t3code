import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as TrackerIssueService from "../issue/IssueService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";

type Row = {
  readonly from_table: number;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly live: number;
  readonly linked: number;
  readonly claim_json: string | null;
};

const decodeClaim = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadLinkedIssue));
const issueKey = (row: Pick<Row, "host" | "repository" | "number">) =>
  `${row.host.toLowerCase()}/${row.repository.toLowerCase()}#${row.number}`;

/**
 * Moves the retired `issue_thread_links` rows, and claims written before claims carried their
 * link, onto `thread.issues[]` as commands, so the links survive a projection rebuild. A claim
 * whose thread has had any link change is not an old claim: someone removed its link. The command
 * id names the thread and the issue, so a rerun replays its receipt and changes nothing.
 */
export const run = Effect.fn("IssueLinkBackfill.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const issues = yield* TrackerIssueService.IssueService;
  const linkedSql = (thread: string, host: string, repository: string, number: string) => sql`
    EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${sql.unsafe(thread)}.payload_json)
        THEN ${sql.unsafe(thread)}.payload_json ELSE '{}' END, '$.issues') link
      WHERE json_extract(link.value, '$.tracker') = 'github'
        AND lower(json_extract(link.value, '$.host')) = lower(${sql.unsafe(host)})
        AND lower(json_extract(link.value, '$.scope')) = lower(${sql.unsafe(repository)})
        AND json_extract(link.value, '$.key') = CAST(${sql.unsafe(number)} AS TEXT))`;
  const rows = yield* sql<Row>`
    SELECT 1 AS from_table, row.host, row.repository, row.issue_number AS number, row.thread_id,
      thread.project_id, thread.thread_id IS NOT NULL AND thread.deleted_at IS NULL AS live,
      COALESCE(${linkedSql("thread", "row.host", "row.repository", "row.issue_number")}, 0) AS linked,
      CASE WHEN json_valid(thread.payload_json)
        THEN json_extract(thread.payload_json, '$.linkedIssue') END AS claim_json
    FROM issue_thread_links row
    LEFT JOIN orchestration_v2_projection_threads thread ON thread.thread_id = row.thread_id
    UNION ALL
    SELECT 0, json_extract(claimed.payload_json, '$.linkedIssue.host'),
      json_extract(claimed.payload_json, '$.linkedIssue.repository'),
      json_extract(claimed.payload_json, '$.linkedIssue.number'), claimed.thread_id,
      claimed.project_id, 1, 0, json_extract(claimed.payload_json, '$.linkedIssue')
    FROM orchestration_v2_projection_threads claimed
    WHERE claimed.deleted_at IS NULL
      AND lower(CASE WHEN json_valid(claimed.payload_json) THEN json_extract(claimed.payload_json, '$.linkedIssue.host') END) > ''
      AND NOT EXISTS (SELECT 1 FROM orchestration_events event
        WHERE event.aggregate_kind = 'thread' AND event.stream_id = claimed.thread_id
          AND event.event_type = 'thread.issue-synced')
      AND NOT ${linkedSql(
        "claimed",
        "json_extract(claimed.payload_json, '$.linkedIssue.host')",
        "json_extract(claimed.payload_json, '$.linkedIssue.repository')",
        "json_extract(claimed.payload_json, '$.linkedIssue.number')",
      )}
  `;
  const removeRow = (row: Row) =>
    sql`DELETE FROM issue_thread_links WHERE host = ${row.host} AND repository = ${row.repository}
      AND issue_number = ${row.number} AND thread_id = ${row.thread_id}`;
  const pending: Array<Row & { readonly projectId: ProjectId }> = [];
  for (const row of rows) {
    if (row.live === 1 && row.linked === 0 && row.project_id !== null)
      pending.push({ ...row, projectId: ProjectId.make(row.project_id) });
    else if (row.from_table === 1) yield* removeRow(row);
  }
  const titles = new Map<string, string>();
  const unnamed = new Map<string, (typeof pending)[number]>();
  for (const row of pending) {
    const claim = Option.getOrUndefined(decodeClaim(row.claim_json));
    const title = claim?.title.trim();
    if (claim !== undefined && title && issueKey(claim) === issueKey(row))
      titles.set(issueKey(row), title);
  }
  for (const row of pending) if (!titles.has(issueKey(row))) unnamed.set(issueKey(row), row);
  yield* Effect.forEach(
    unnamed,
    ([key, row]) =>
      issues
        .detail({
          projectId: row.projectId,
          tracker: IssueTrackerKind.make("github"),
          host: row.host.toLowerCase(),
          scope: row.repository,
          key: String(row.number),
        })
        .pipe(
          Effect.map((detail) => void titles.set(key, detail.title)),
          // The row stays for the next start.
          Effect.catch((error) =>
            Effect.logWarning("issue link backfill could not read an issue title", {
              issue: key,
              reason: error.message,
            }),
          ),
        ),
    { concurrency: 4, discard: true },
  );
  for (const row of pending) {
    const title = titles.get(issueKey(row));
    if (title === undefined) continue;
    const host = row.host.toLowerCase();
    yield* orchestrator
      .dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make(`fork:issue-link-backfill:${row.thread_id}:${issueKey(row)}`),
        threadId: ThreadId.make(row.thread_id),
        tracker: IssueTrackerKind.make("github"),
        host,
        scope: row.repository,
        key: String(row.number),
        projectId: row.projectId,
        url: `https://${host}/${row.repository}/issues/${row.number}`,
        displayKey: `#${row.number}`,
        title,
        source: "agent",
      })
      .pipe(
        Effect.andThen(row.from_table === 1 ? removeRow(row) : Effect.void),
        Effect.catch((error) =>
          Effect.logWarning("issue link backfill could not link a thread", {
            thread: row.thread_id,
            issue: issueKey(row),
            reason: error.message,
          }),
        ),
      );
  }
});

export const layer = Layer.effectDiscard(
  forkParked(
    run().pipe(
      Effect.catchCause((cause) => Effect.logWarning("issue link backfill failed", { cause })),
    ),
  ),
);
