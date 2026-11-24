import {
  IssueQueueEntry,
  IssueWorkError,
  type IssueRepositoryRef,
  type ThreadLinkedIssue,
  type OrchestrationV2DomainEvent,
  ThreadId,
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
      AND queue_state = 'queued'
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
      SET queue_state = 'removed', payload_json = json_set(payload_json, '$.state', 'removed')
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND issue_id = ${issue.id}
        AND queue_state = 'queued'
    `;
});

export const issueQueueMailbox = (issue: Pick<ThreadLinkedIssue, "host" | "repositoryId">) =>
  ThreadId.make(`issue-queue:${issue.host}:${issue.repositoryId}`);

/** Prefix of the start request id for a queued issue; its worker thread id carries it. */
export const QUEUED_ISSUE_START_PREFIX = "issue-queue-start:";
