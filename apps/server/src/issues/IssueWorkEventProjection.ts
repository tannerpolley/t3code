import {
  IssueWorkCancelled,
  IssueWorkRequested,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { applyIssueQueueEvent, claimQueuedIssue } from "./IssueQueueStore.ts";
import type { ProjectionStoreApplyEventError } from "../orchestration-v2/ProjectionStore.ts";

const encodeIssueCancellation = Schema.encodeEffect(Schema.fromJsonString(IssueWorkCancelled));
const encodeIssueRequest = Schema.encodeEffect(Schema.fromJsonString(IssueWorkRequested));

// These hooks run inside the projection's existing event span and SQL transaction.
export const makeIssueWorkProjection = (
  sql: SqlClient.SqlClient,
  ApplyError: typeof ProjectionStoreApplyEventError,
) => {
  const registerRepositoryOwner = (
    owner: import("@t3tools/contracts").RepositoryOrchestration,
    threadId: ThreadId,
    occurredAt: DateTime.Utc,
  ) =>
    sql`
        INSERT INTO orchestration_v2_projection_repository_orchestration (
          host, repository_id, repository, root_thread_id, project_id, workspace,
          launch_command_id, revision, paused, worker_limit, publish_status_comments,
          publish_closeout_comments, created_at, updated_at
        ) VALUES (
          ${owner.host}, ${owner.repositoryId}, ${owner.repository}, ${threadId},
          ${owner.projectId}, ${"worktree"}, ${owner.launchCommandId},
          ${owner.revision}, ${owner.paused ? 1 : 0}, ${owner.workerLimit},
          ${owner.publishStatusComments ? 1 : 0}, ${owner.publishCloseoutComments ? 1 : 0},
          ${DateTime.formatIso(occurredAt)}, ${DateTime.formatIso(occurredAt)}
        )
      `;

  const applyEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    switch (event.type) {
      case "repository.work.restored":
        // Existing roots have no thread.created event to register their first owner.
        if (event.payload.previousRootThreadId === null) {
          yield* registerRepositoryOwner(
            event.payload.repositoryOrchestration,
            event.payload.targetThreadId,
            event.occurredAt,
          );
        }
        return;
      case "issue.queue.updated":
        yield* applyIssueQueueEvent(event).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        return;
      case "issue.work.cancelled": {
        const payload = yield* encodeIssueCancellation(event.payload);
        yield* sql`
                UPDATE orchestration_v2_projection_issue_work_requests
                SET payload_json = json_set(payload_json, '$.cancellation', json_extract(${payload}, '$.cancellation'))
                WHERE request_id = ${event.payload.requestId}
                  AND json_type(payload_json, '$.cancellation') IS NULL
              `;
        return;
      }
      case "issue.work.requested": {
        const request = event.payload;
        yield* claimQueuedIssue(request.issue).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (request.issueThreadId === null) {
          yield* sql`
                  INSERT INTO orchestration_v2_projection_issue_work
                    (host, repository_id, issue_id, issue_number, repository, node_id, issue_url,
                     issue_title, owner_thread_id, status_marker, updated_at)
                  VALUES (${request.issue.host}, ${request.issue.repositoryId}, ${request.issue.id},
                    ${request.issue.number}, ${request.issue.repository}, ${request.issue.nodeId},
                    ${request.issue.url}, ${request.issue.title}, ${null},
                    ${`<!-- t3-issue-status:${request.issue.host}:${request.issue.repositoryId}:${request.issue.id} -->`},
                    ${DateTime.formatIso(event.occurredAt)})
                  ON CONFLICT(host, repository_id, issue_id) DO UPDATE SET
                    repository = excluded.repository,
                    issue_number = excluded.issue_number,
                    node_id = excluded.node_id,
                    issue_url = excluded.issue_url,
                    issue_title = excluded.issue_title,
                    updated_at = excluded.updated_at
                `;
        }
        const payloadJson = yield* encodeIssueRequest(request);
        yield* sql`
                INSERT INTO orchestration_v2_projection_issue_work_requests
                  (request_id, host, repository_id, repository, issue_id, issue_number, attempt_key, root_thread_id, payload_json, created_at)
                VALUES (${request.requestId}, ${request.issue.host}, ${request.issue.repositoryId}, ${request.issue.repository}, ${request.issue.id}, ${request.issue.number}, ${request.attemptKey}, ${request.rootThreadId}, ${payloadJson}, ${DateTime.formatIso(event.occurredAt)})
                ON CONFLICT(request_id) DO NOTHING
              `;
        return;
      }
      case "issue.github-comment.recorded": {
        const receipt = event.payload;
        if (receipt.operation === "status_sync") {
          yield* sql`
                  INSERT INTO orchestration_v2_projection_issue_work
                    (host, repository_id, issue_id, issue_number, repository, node_id, issue_url,
                     issue_title, owner_thread_id, status_comment_id, status_marker, updated_at)
                  VALUES (${receipt.issue.host}, ${receipt.issue.repositoryId}, ${receipt.issue.id},
                    ${receipt.issue.number}, ${receipt.issue.repository}, ${receipt.issue.nodeId},
                    ${receipt.issue.url}, ${receipt.issue.title}, ${null},
                    ${receipt.commentId}, ${receipt.marker}, ${DateTime.formatIso(event.occurredAt)})
                  ON CONFLICT(host, repository_id, issue_id) DO UPDATE SET
                    status_comment_id = excluded.status_comment_id,
                    status_marker = excluded.status_marker,
                    updated_at = excluded.updated_at
                `;
        } else {
          yield* sql`
                  INSERT INTO orchestration_v2_projection_issue_comment_receipts
                    (write_key, host, repository_id, issue_id, issue_number, thread_id,
                     result_event_id, comment_id, marker, created_at, updated_at)
                  VALUES (${receipt.writeKey}, ${receipt.issue.host}, ${receipt.issue.repositoryId},
                    ${receipt.issue.id}, ${receipt.issue.number}, ${receipt.threadId},
                    ${receipt.resultEventId ?? null}, ${receipt.commentId}, ${receipt.marker},
                    ${DateTime.formatIso(event.occurredAt)}, ${DateTime.formatIso(event.occurredAt)})
                  ON CONFLICT(write_key) DO UPDATE SET
                    comment_id = excluded.comment_id,
                    marker = excluded.marker,
                    updated_at = excluded.updated_at
                `;
        }
        return;
      }
      default:
        return;
    }
  });
  const applyThread = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationV2DomainEvent,
      { payload: import("@t3tools/contracts").OrchestrationV2AppThread }
    >,
  ) {
    if (event.type === "thread.created" && event.payload.repositoryOrchestration !== undefined) {
      yield* registerRepositoryOwner(
        event.payload.repositoryOrchestration,
        event.threadId,
        event.occurredAt,
      );
    }
    if (event.type === "thread.created" && event.payload.linkedIssue !== undefined) {
      const issue = event.payload.linkedIssue;
      yield* claimQueuedIssue(issue).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* sql`
                  INSERT INTO orchestration_v2_projection_issue_work
                    (host, repository_id, issue_id, issue_number, repository, node_id, issue_url,
                     issue_title, owner_thread_id, status_marker, updated_at)
                  VALUES (${issue.host}, ${issue.repositoryId}, ${issue.id}, ${issue.number},
                    ${issue.repository}, ${issue.nodeId}, ${issue.url}, ${issue.title},
                    ${event.threadId}, ${`<!-- t3-issue-status:${issue.host}:${issue.repositoryId}:${issue.id} -->`},
                    ${DateTime.formatIso(event.occurredAt)})
                  ON CONFLICT(host, repository_id, issue_id) DO UPDATE SET
                    repository = excluded.repository,
                    issue_number = excluded.issue_number,
                    node_id = excluded.node_id,
                    issue_url = excluded.issue_url,
                    issue_title = excluded.issue_title,
                    owner_thread_id = excluded.owner_thread_id,
                    updated_at = excluded.updated_at
                `;
    }
    if (
      event.payload.repositoryOrchestration !== undefined &&
      event.payload.repositoryOrchestration.retiredToThreadId === undefined
    ) {
      const owner = event.payload.repositoryOrchestration;
      const updated = yield* sql<{ readonly root_thread_id: string }>`
                  UPDATE orchestration_v2_projection_repository_orchestration
                  SET paused = ${owner.paused ? 1 : 0}, worker_limit = ${owner.workerLimit},
                      revision = ${owner.revision}, updated_at = ${DateTime.formatIso(event.occurredAt)}
                  WHERE root_thread_id = ${event.threadId} RETURNING root_thread_id
                `;
      if (updated.length === 0) {
        const previous = owner.handoffHistory?.at(-1);
        const transferred =
          previous === undefined
            ? []
            : yield* sql<{ readonly root_thread_id: string }>`
                          UPDATE orchestration_v2_projection_repository_orchestration
                          SET root_thread_id = ${event.threadId}, launch_command_id = ${owner.launchCommandId},
                            paused = ${owner.paused ? 1 : 0}, worker_limit = ${owner.workerLimit},
                            revision = ${owner.revision}, updated_at = ${DateTime.formatIso(event.occurredAt)}
                          WHERE host = ${owner.host} AND repository_id = ${owner.repositoryId}
                            AND root_thread_id IN ${sql.in(owner.handoffHistory!.map((entry) => entry.threadId))}
                            AND revision < ${owner.revision}
                          RETURNING root_thread_id
                        `;
        if (transferred.length === 0) {
          return yield* new ApplyError({
            eventType: event.type,
            cause: "Repository ownership revision conflict during handoff.",
          });
        }
        // Only unclaimed admissions move. Attempts and child lineage stay historical.
        yield* sql`
                    UPDATE orchestration_v2_projection_issue_work_requests
                    SET root_thread_id = ${event.threadId},
                        payload_json = json_set(payload_json, '$.rootThreadId', ${event.threadId})
                    WHERE root_thread_id IN ${sql.in(owner.handoffHistory!.map((entry) => entry.threadId))}
                      AND queue_state IS NULL AND json_type(payload_json, '$.cancellation') IS NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM orchestration_v2_projection_issue_work work
                        WHERE work.host = orchestration_v2_projection_issue_work_requests.host
                          AND work.repository_id = orchestration_v2_projection_issue_work_requests.repository_id
                          AND work.issue_id = orchestration_v2_projection_issue_work_requests.issue_id
                          AND work.owner_thread_id IS NOT NULL
                          AND work.owner_thread_id <> orchestration_v2_projection_issue_work_requests.attempt_key
                      )
                  `;
      }
    }
  });
  return { applyEvent, applyThread };
};
