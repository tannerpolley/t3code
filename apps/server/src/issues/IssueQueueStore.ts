import {
  IssueQueueEntry,
  IssueWorkError,
  type IssueRepositoryRef,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";

const decode = Schema.decodeEffect(Schema.fromJsonString(IssueQueueEntry));
const encode = Schema.encodeEffect(Schema.fromJsonString(IssueQueueEntry));

export const readIssueQueue = Effect.fn("IssueQueueStore.readIssueQueue")(
  function* (input: IssueRepositoryRef) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_issue_work_requests
    WHERE lower(host) = lower(${input.host}) AND lower(repository) = lower(${input.repository})
      AND queue_state IN ('queued', 'needs_attention')
    ORDER BY rowid
  `;
    return yield* Effect.forEach(rows, (row) => decode(row.payload_json));
  },
  Effect.mapError(
    () =>
      new IssueWorkError({
        code: "orchestration-error",
        message: "Could not read the issue queue.",
      }),
  ),
);

// Projection application already owns the span for each event.
export const applyIssueQueueEvent = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { type: "issue.queue.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const entry = event.payload;
  const payload = yield* encode(entry);
  yield* sql`
    INSERT INTO orchestration_v2_projection_issue_work_requests
      (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key,
       root_thread_id, payload_json, created_at, queue_state)
    VALUES (${entry.requestId}, ${entry.issue.host}, ${entry.issue.repositoryId},
      ${entry.issue.repository}, ${entry.issue.id}, ${entry.issue.number}, ${entry.requestId},
      ${event.threadId}, ${payload}, ${DateTime.formatIso(event.occurredAt)}, ${entry.state})
    ON CONFLICT(request_id) DO UPDATE SET payload_json = excluded.payload_json,
      queue_state = excluded.queue_state, root_thread_id = excluded.root_thread_id
  `;
});

// This projection helper runs within the enclosing event application span.
export const claimQueuedIssue = Effect.fnUntraced(function* (issue: IssueQueueEntry["issue"]) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE orchestration_v2_projection_issue_work_requests
      SET queue_state = 'removed', payload_json = json_remove(json_set(payload_json, '$.state', 'removed'), '$.noticeRunId')
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND issue_id = ${issue.id}
        AND queue_state IN ('queued', 'needs_attention')
    `;
});

export const isIssueQueueNoticeRun = Effect.fn("IssueQueueStore.isIssueQueueNoticeRun")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
      SELECT 1 FROM orchestration_events event
      JOIN orchestration_command_receipts receipt ON receipt.command_id = event.command_id
      WHERE event.aggregate_kind = 'thread' AND event.stream_id = ${threadId}
        AND event.application_event_version = 2 AND json_extract(event.metadata_json, '$.runId') = ${runId}
        AND event.event_type = 'run.created' AND receipt.command_type = 'issue.queue.deliver'
      LIMIT 1
    `;
  return rows.length > 0;
});

export const readIssueQueueNotice = Effect.fn("IssueQueueStore.readIssueQueueNotice")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ payload_json: string }>`
    SELECT request.payload_json FROM orchestration_events event
    JOIN orchestration_v2_projection_issue_work_requests request
      ON request.request_id = json_extract(event.payload_json, '$.requestId')
    WHERE event.aggregate_kind = 'thread' AND event.stream_id = ${threadId}
      AND event.application_event_version = 2 AND event.event_type = 'issue.queue.updated'
      AND json_extract(event.payload_json, '$.noticeRunId') = ${runId}
      AND request.queue_state = 'needs_attention'
    ORDER BY event.sequence DESC LIMIT 1
  `;
  return row === undefined ? null : yield* decode(row.payload_json);
});

// This projection helper runs within the enclosing event application span.
export const finishIssueQueueNotice = Effect.fnUntraced(function* (run: OrchestrationV2Run) {
  if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return;
  const sql = yield* SqlClient.SqlClient;
  const state = run.status === "completed" ? "needs_attention" : "queued";
  yield* sql`
      UPDATE orchestration_v2_projection_issue_work_requests
      SET queue_state = ${state}, payload_json = json_remove(json_set(payload_json, '$.state', ${state}), '$.noticeRunId')
      WHERE root_thread_id = ${run.threadId} AND queue_state = 'queued'
        AND json_extract(payload_json, '$.noticeRunId') = ${run.id}
    `;
});
