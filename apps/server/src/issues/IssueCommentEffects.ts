import {
  CommandId,
  ISSUE_WORK_STATUS_LABELS,
  IssueWorkRequested,
  ThreadId,
  type ThreadLinkedIssue,
  type IssueWorkStatus,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationEffectRequestV2,
  type PendingOrchestrationEffectV2,
  type EffectOutboxV2Shape,
} from "../orchestration-v2/EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { delegatedTaskProgress } from "../orchestration-v2/SubagentProjection.ts";
import { deriveIssueWorkStatus } from "./IssueWorkStatus.ts";

const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(IssueWorkRequested));
const decodeCommentEffect = Schema.decodeEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

function statusCommentEffect(input: {
  readonly issue: ThreadLinkedIssue;
  readonly threadId: ThreadId;
  readonly status: IssueWorkStatus;
  readonly revision: number;
  readonly model: string;
  readonly branch: string | null;
  readonly updatedAt: DateTime.Utc;
}): PendingOrchestrationEffectV2 {
  const marker = `<!-- t3-issue-status:${input.issue.host}:${input.issue.repositoryId}:${input.issue.id} -->`;
  const writeKey = `issue-status:${input.issue.host}:${input.issue.repositoryId}:${input.issue.id}:${input.revision}`;
  return {
    id: `effect:issue-comment:${writeKey}`,
    commandId: CommandId.make(`command:issue-comment:${writeKey}`),
    threadId: input.threadId,
    request: {
      type: "issue.github.comment",
      operation: "status_sync",
      issue: input.issue,
      writeKey,
      marker,
      status: input.status,
      revision: input.revision,
      model: input.model,
      branch: input.branch,
      body: [
        `**T3 Code status: ${ISSUE_WORK_STATUS_LABELS[input.status]}**`,
        `Issue: [#${input.issue.number} ${input.issue.title}](${input.issue.url})`,
        `Thread: ${input.threadId}`,
        `Model: ${input.model}`,
        ...(input.branch === null ? [] : [`Branch: ${input.branch}`]),
        `Updated: ${DateTime.formatIso(input.updatedAt)}`,
        marker,
      ].join("\n\n"),
    },
  };
}

const STATUS_EVENTS = new Set([
  "issue.work.requested",
  "thread.created",
  "thread.metadata-updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
  "run.background-work-cancelled",
]);

/** Runs after projection updates inside the sink transaction, for every provider and command path. */
export const enqueueIssueStatusEffects = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly projections: ProjectionStoreV2Shape;
  readonly outbox: EffectOutboxV2Shape;
  readonly events: ReadonlyArray<OrchestrationV2StoredEvent>;
}) =>
  Effect.gen(function* () {
    const { sql, projections, outbox } = input;
    const relevant = input.events.filter(
      (stored) =>
        STATUS_EVENTS.has(stored.event.type) ||
        (stored.event.type === "turn-item.updated" &&
          ["command_execution", "dynamic_tool", "subagent"].includes(stored.event.payload.type) &&
          ["completed", "failed", "cancelled", "interrupted"].includes(
            stored.event.payload.status,
          )),
    );
    if (relevant.length === 0) return 0;
    const managedThreads = yield* sql<{ thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE thread_id IN ${sql.in([...new Set(relevant.map((stored) => stored.event.threadId))])}
      AND (json_type(payload_json, '$.linkedIssue') = 'object' OR json_type(payload_json, '$.repositoryOrchestration') = 'object')
  `;
    if (managedThreads.length === 0) return 0;
    const issues = new Map<string, ThreadLinkedIssue>();
    const add = (issue: ThreadLinkedIssue) =>
      issues.set(`${issue.host}:${issue.repositoryId}:${issue.id}`, issue);
    for (const row of managedThreads) {
      const threadId = ThreadId.make(row.thread_id);
      const thread = yield* projections.getThread(threadId);
      if (thread.linkedIssue !== undefined) add(thread.linkedIssue);
      if (thread.repositoryOrchestration === undefined) continue;
      const queued = yield* sql<{ payload_json: string }>`
      SELECT request.payload_json FROM orchestration_v2_projection_issue_work_requests request
      LEFT JOIN orchestration_v2_projection_issue_work work
        ON work.host = request.host AND work.repository_id = request.repository_id AND work.issue_id = request.issue_id
      WHERE request.root_thread_id = ${threadId}
        AND (work.owner_thread_id IS NULL OR request.attempt_key = work.owner_thread_id)
        AND request.rowid = (SELECT max(latest.rowid) FROM orchestration_v2_projection_issue_work_requests latest
          WHERE latest.host = request.host AND latest.repository_id = request.repository_id AND latest.issue_id = request.issue_id)
    `;
      for (const row of queued) add((yield* decodeRequest(row.payload_json)).issue);
    }
    const revision = input.events.at(-1)?.sequence ?? 0;
    let count = 0;
    for (const issue of issues.values()) {
      const policy = yield* sql<{ root_thread_id: string; paused: number }>`
      SELECT root_thread_id, paused FROM orchestration_v2_projection_repository_orchestration
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND publish_status_comments = 1
    `;
      if (policy[0] === undefined) continue;
      const work = yield* projections.getIssueWorkCommentState({
        threadId: relevant[0]!.event.threadId,
        host: issue.host,
        repositoryId: issue.repositoryId,
        issueId: issue.id,
      });
      if (work?.effectiveStatusThreadId == null) continue;
      const threadId = work.effectiveStatusThreadId;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null) continue;
      const projection = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
        "subagents",
        "runtimeRequests",
      ]);
      const queued = work.ownerThreadId !== threadId;
      let status: IssueWorkStatus;
      if (queued) {
        status = deriveIssueWorkStatus({
          shell,
          runtimeRequests: projection.runtimeRequests,
          paused: policy[0].paused === 1,
          waitingOnSubIssues: false,
          queued: true,
        });
      } else {
        const progress = delegatedTaskProgress({
          ...projection,
          pendingBackgroundTasks: shell.pendingBackgroundTasks ?? [],
        });
        status = deriveIssueWorkStatus({
          shell,
          runtimeRequests: projection.runtimeRequests,
          paused: policy[0].paused === 1,
          waitingOnSubIssues: progress.state === "waiting_for_children",
          resultAvailable: progress.state === "result_available",
        });
      }
      const previous = yield* sql<{ payload_json: string; thread_id: string }>`
      SELECT payload_json, thread_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'issue.github.comment' AND json_extract(payload_json, '$.operation') = 'status_sync'
        AND json_extract(payload_json, '$.issue.host') = ${issue.host}
        AND json_extract(payload_json, '$.issue.repositoryId') = ${issue.repositoryId}
        AND json_extract(payload_json, '$.issue.id') = ${issue.id}
      ORDER BY coalesce(json_extract(payload_json, '$.revision'), 0) DESC, rowid DESC LIMIT 1
    `;
      if (previous[0] !== undefined) {
        const desired = yield* decodeCommentEffect(previous[0].payload_json);
        if (
          desired.type === "issue.github.comment" &&
          desired.status === status &&
          previous[0].thread_id === threadId &&
          desired.model === shell.modelSelection.model &&
          desired.branch === shell.branch &&
          desired.issue.title === issue.title
        )
          continue;
      }
      // Older pending revisions have no useful work left. A running write finishes
      // under the executor's issue lock; any later retry checks the latest key.
      yield* sql`
      UPDATE orchestration_v2_effect_outbox SET status = 'cancelled', last_error = 'Superseded issue status'
      WHERE effect_type = 'issue.github.comment' AND status IN ('pending', 'failed')
        AND json_extract(payload_json, '$.operation') = 'status_sync'
        AND json_extract(payload_json, '$.issue.host') = ${issue.host}
        AND json_extract(payload_json, '$.issue.repositoryId') = ${issue.repositoryId}
        AND json_extract(payload_json, '$.issue.id') = ${issue.id}
    `;
      yield* outbox.enqueue([
        statusCommentEffect({
          issue,
          threadId,
          status,
          revision,
          model: shell.modelSelection.model,
          branch: shell.branch,
          updatedAt: yield* DateTime.now,
        }),
      ]);
      count += 1;
    }
    return count;
  });
