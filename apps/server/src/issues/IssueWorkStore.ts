import {
  IssueWorkError,
  IssueWorkRequested,
  ProjectId,
  ThreadId,
  type CommandId,
  type IssueRef,
  type ThreadLinkedIssue,
  RepositoryOrchestration,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { openBlockerSuspensionReason } from "./IssueEligibility.ts";

const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(RepositoryOrchestration));
import * as SqlClient from "effect/sql/SqlClient";

type RepositoryOwner = {
  readonly rootThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly paused: boolean;
  readonly revision: number;
};
type RepositoryOwnerRow = {
  readonly root_thread_id: string;
  readonly project_id: string;
  readonly paused: number;
  readonly revision: number;
};
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(IssueWorkRequested));
const ownerFromRows = (rows: ReadonlyArray<RepositoryOwnerRow>): RepositoryOwner | null =>
  rows[0] === undefined
    ? null
    : {
        rootThreadId: ThreadId.make(rows[0].root_thread_id),
        projectId: ProjectId.make(rows[0].project_id),
        paused: rows[0].paused === 1,
        revision: rows[0].revision,
      };

/** Reads ownership projected by committed orchestration events. Never claims outside the event sink. */
export class IssueWorkStore extends Context.Service<
  IssueWorkStore,
  {
    readonly configuration: (
      rootThreadId: ThreadId,
    ) => Effect.Effect<RepositoryOrchestration | null, IssueWorkError>;
    readonly slotsInUse: (rootThreadId: ThreadId) => Effect.Effect<number, IssueWorkError>;
    readonly activeRoots: () => Effect.Effect<ReadonlyArray<ThreadId>, IssueWorkError>;
    readonly subtreeDrained: (rootThreadId: ThreadId) => Effect.Effect<boolean, IssueWorkError>;
    readonly recoveryInventory: (
      repository: Pick<ThreadLinkedIssue, "host" | "repository" | "repositoryId">,
    ) => Effect.Effect<ReadonlyArray<{ section: string; detail: string }>, IssueWorkError>;
    readonly workerThreads: (
      rootThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, IssueWorkError>;
    readonly pendingRequests: (
      rootThreadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<import("@t3tools/contracts").IssueWorkRequested>,
      IssueWorkError
    >;
    readonly resultAvailable: (threadId: ThreadId) => Effect.Effect<boolean, IssueWorkError>;
    readonly canAdmit: (
      issue: ThreadLinkedIssue,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, IssueWorkError>;
    readonly request: (
      requestId: CommandId,
    ) => Effect.Effect<import("@t3tools/contracts").IssueWorkRequested | null, IssueWorkError>;
    readonly requestsForAttempt: (
      request: import("@t3tools/contracts").IssueWorkRequested,
    ) => Effect.Effect<
      ReadonlyArray<import("@t3tools/contracts").IssueWorkRequested>,
      IssueWorkError
    >;
    readonly latestRequest: (
      issue: IssueRef,
    ) => Effect.Effect<import("@t3tools/contracts").IssueWorkRequested | null, IssueWorkError>;
    readonly hasAttempt: (
      issue: ThreadLinkedIssue,
      attemptKey: string,
    ) => Effect.Effect<boolean, IssueWorkError>;
    readonly linkedIssue: (
      issue: IssueRef,
    ) => Effect.Effect<ThreadLinkedIssue | null, IssueWorkError>;
    readonly repositoryOwner: (
      issue: Pick<ThreadLinkedIssue, "host" | "repositoryId">,
    ) => Effect.Effect<RepositoryOwner | null, IssueWorkError>;
    readonly repositoryOwnerByRef: (
      issue: Pick<IssueRef, "host" | "repository">,
    ) => Effect.Effect<RepositoryOwner | null, IssueWorkError>;
    readonly issueOwner: (
      issue: ThreadLinkedIssue,
    ) => Effect.Effect<ThreadId | null, IssueWorkError>;
    /** The issue's owner only when it works under the registered root; a retired subtree's owner is historical. */
    readonly currentIssueOwner: (
      issue: ThreadLinkedIssue,
    ) => Effect.Effect<ThreadId | null, IssueWorkError>;
    readonly hasUnclaimedRequests: (
      rootThreadId: ThreadId,
    ) => Effect.Effect<boolean, IssueWorkError>;
    readonly publishing: (
      threadId: ThreadId,
      issue?: ThreadLinkedIssue,
    ) => Effect.Effect<"absent" | "pending" | "published" | "failed", IssueWorkError>;
  }
>()("t3/issues/IssueWorkStore") {}

export const layer = Layer.effect(
  IssueWorkStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mapError = (cause: unknown) =>
      new IssueWorkError({ code: "orchestration-error", message: String(cause) });
    // Keep the displayed occupancy and admission rule identical. `thread` is the worker alias.
    const usesWorkerSlot = sql`(EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs run
      WHERE run.thread_id = thread.thread_id
        AND run.status IN ('preparing', 'starting', 'running', 'waiting')
    ) OR EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runtime_requests request
      WHERE request.thread_id = thread.thread_id AND request.status = 'pending'
        AND request.kind NOT IN ('auth_refresh', 'dynamic_tool_call')
    ))`;
    return IssueWorkStore.of({
      slotsInUse: (rootThreadId) =>
        sql<{ active: number }>`
          SELECT count(*) AS active FROM orchestration_v2_projection_issue_work work
          JOIN orchestration_v2_projection_threads thread ON thread.thread_id = work.owner_thread_id
          JOIN orchestration_v2_projection_repository_orchestration owner
            ON owner.host = work.host AND owner.repository_id = work.repository_id
          WHERE owner.root_thread_id = ${rootThreadId} AND ${usesWorkerSlot}
        `.pipe(
          Effect.map((rows) => rows[0]!.active),
          Effect.mapError(mapError),
        ),
      subtreeDrained: (rootThreadId) =>
        sql<{ thread_id: string }>`
          WITH subtree AS MATERIALIZED (
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${rootThreadId}
              OR json_extract(payload_json, '$.lineage.rootThreadId') = ${rootThreadId}
          )
          SELECT thread_id FROM subtree
          WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run
              WHERE run.thread_id = subtree.thread_id
                AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents task
              WHERE task.thread_id = subtree.thread_id AND (
                task.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
                OR json_extract(task.payload_json, '$.completionDelivery.state') IN ('pending', 'claimed')))
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = subtree.thread_id AND request.status = 'pending')
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads provider
              WHERE provider.thread_id = subtree.thread_id
                AND json_array_length(provider.payload_json, '$.pendingBackgroundTasks') > 0)
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = subtree.thread_id AND item.status IN ('pending', 'running', 'waiting'))
            -- A restart cancels the cut run before its continuation dispatches; other
            -- provider lifecycle effects belong to runs that are still active above.
            OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox effect
              WHERE effect.thread_id = subtree.thread_id AND effect.status IN ('pending', 'running')
                AND effect.effect_type = 'provider-runtime.continue')
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows.length === 0),
          Effect.mapError(mapError),
        ),
      recoveryInventory: (repository) =>
        sql<{ section: string; detail: string }>`
          SELECT 'Completed attempts' AS section,
            '#' || json_extract(child.payload_json, '$.linkedIssue.number') || ' — ' || task.status
            || ' — thread ' || child.thread_id || char(10)
            || COALESCE(substr(json_extract(task.payload_json, '$.result'), 1, 6000), '') AS detail
          FROM orchestration_v2_projection_subagents task
          JOIN orchestration_v2_projection_threads child ON child.thread_id = task.child_thread_id
          WHERE task.origin = 'app_owned' AND task.status IN ('completed', 'failed', 'cancelled', 'interrupted')
            AND json_extract(child.payload_json, '$.linkedIssue.host') = ${repository.host}
            AND json_extract(child.payload_json, '$.linkedIssue.repositoryId') = ${repository.repositoryId}
          UNION ALL
          SELECT 'Remaining issue requests', '#' || request.issue_number || ' — ' || json_extract(request.payload_json, '$.issue.title')
          FROM orchestration_v2_projection_issue_work_requests request
          LEFT JOIN orchestration_v2_projection_issue_work work
            ON work.host = request.host AND work.repository_id = request.repository_id AND work.issue_id = request.issue_id
          WHERE request.host = ${repository.host} AND request.repository_id = ${repository.repositoryId}
            AND json_type(request.payload_json, '$.cancellation') IS NULL
            AND (work.owner_thread_id IS NULL OR request.attempt_key = work.owner_thread_id)
          UNION ALL
          SELECT 'Pending changes', effect.effect_type || ' — ' || effect.status || ' — ' || COALESCE(effect.last_error, 'awaiting writeback')
          FROM orchestration_v2_effect_outbox effect
          WHERE effect.effect_type LIKE 'issue.%' AND effect.status IN ('pending', 'running', 'failed')
            AND json_extract(effect.payload_json, '$.issue.host') = ${repository.host}
            AND json_extract(effect.payload_json, '$.issue.repositoryId') = ${repository.repositoryId}
          UNION ALL
          SELECT 'Pending changes', 'Issue change ' || change.change_id || ' — '
            || json_extract(change.proposal_json, '$.operation.type')
            || COALESCE(' #' || change.issue_number, '') || ' — ' || change.decision || ', ' || change.status
          FROM issue_changes change
          WHERE change.host = ${repository.host} AND lower(change.repository) = lower(${repository.repository})
            AND change.status IN ('pending', 'queued', 'executing', 'failed', 'conflict')
          ORDER BY section, detail
        `.pipe(Effect.mapError(mapError)),
      resultAvailable: (threadId) =>
        sql<{
          status: string;
        }>`SELECT status FROM orchestration_v2_projection_subagents WHERE child_thread_id = ${threadId} AND origin = 'app_owned' LIMIT 1`.pipe(
          Effect.map((rows) =>
            rows.some((row) =>
              ["completed", "failed", "interrupted", "cancelled"].includes(row.status),
            ),
          ),
          Effect.mapError(mapError),
        ),
      pendingRequests: (rootThreadId) =>
        sql<{ payload_json: string }>`
        SELECT request.payload_json FROM orchestration_v2_projection_issue_work_requests request
        LEFT JOIN orchestration_v2_projection_issue_work work
          ON work.host = request.host AND work.repository_id = request.repository_id AND work.issue_id = request.issue_id
        WHERE request.root_thread_id = ${rootThreadId}
          AND json_type(request.payload_json, '$.cancellation') IS NULL
          AND (work.owner_thread_id IS NULL OR request.attempt_key = work.owner_thread_id)
          AND request.rowid = (SELECT max(latest.rowid) FROM orchestration_v2_projection_issue_work_requests latest
            WHERE latest.host = request.host AND latest.repository_id = request.repository_id AND latest.issue_id = request.issue_id)
      `.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRequest(row.payload_json))),
          Effect.mapError(mapError),
        ),
      configuration: (rootThreadId) =>
        sql<{ configuration: string }>`
        SELECT json_extract(payload_json, '$.repositoryOrchestration') AS configuration
        FROM orchestration_v2_projection_threads WHERE thread_id = ${rootThreadId}
          AND json_type(payload_json, '$.repositoryOrchestration') = 'object'
      `.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(null)
              : decodeConfiguration(rows[0].configuration),
          ),
          Effect.mapError(mapError),
        ),
      activeRoots: () =>
        sql<{ root_thread_id: string }>`
        SELECT root_thread_id FROM orchestration_v2_projection_repository_orchestration owner
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = owner.root_thread_id
        WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL
          AND (json_extract(thread.payload_json, '$.repositoryOrchestration.handoff.status') = 'draining'
            OR (owner.paused = 0 AND EXISTS (
              SELECT 1 FROM json_each(thread.payload_json, '$.repositoryOrchestration.suspendedIssues') suspension
              WHERE json_extract(suspension.value, '$.reason') = ${openBlockerSuspensionReason}))
            OR EXISTS (SELECT 1 FROM json_each(thread.payload_json, '$.repositoryOrchestration.milestones') plan
            WHERE json_extract(plan.value, '$.status') <> 'complete')
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_issue_work_requests request
              LEFT JOIN orchestration_v2_projection_issue_work work ON work.host = request.host AND work.repository_id = request.repository_id AND work.issue_id = request.issue_id
              WHERE request.root_thread_id = owner.root_thread_id AND work.owner_thread_id IS NULL AND json_type(request.payload_json, '$.cancellation') IS NULL)
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_threads worker JOIN orchestration_v2_projection_runs run ON run.thread_id = worker.thread_id
              WHERE json_extract(worker.payload_json, '$.lineage.rootThreadId') = owner.root_thread_id
                AND json_type(worker.payload_json, '$.linkedIssue') = 'object' AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')))

      `.pipe(
          Effect.map((rows) => rows.map((row) => ThreadId.make(row.root_thread_id))),
          Effect.mapError(mapError),
        ),
      workerThreads: (rootThreadId) =>
        sql<{ thread_id: string }>`
        SELECT thread.thread_id FROM orchestration_v2_projection_threads thread
        JOIN orchestration_v2_projection_issue_work work ON work.owner_thread_id = thread.thread_id
        JOIN orchestration_v2_projection_repository_orchestration repository
          ON repository.host = work.host AND repository.repository_id = work.repository_id
        WHERE repository.root_thread_id = ${rootThreadId}
          AND json_extract(thread.payload_json, '$.lineage.rootThreadId') = ${rootThreadId}
          AND thread.deleted_at IS NULL AND thread.archived_at IS NULL
        ORDER BY thread.created_at, thread.thread_id
      `.pipe(
          Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
          Effect.mapError(mapError),
        ),
      canAdmit: (issue, threadId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            paused: number;
            worker_limit: number;
            active: number;
            suspended: number;
            draining: number;
            lineage_valid: number;
          }>`
          SELECT owner.paused, owner.worker_limit,
            COALESCE(json_extract(root.payload_json, '$.repositoryOrchestration.handoff.status') = 'draining', 0) AS draining,
            EXISTS (SELECT 1 FROM orchestration_v2_projection_threads candidate
              WHERE candidate.thread_id = ${threadId}
                AND json_extract(candidate.payload_json, '$.lineage.rootThreadId') = owner.root_thread_id) AS lineage_valid,
            (SELECT count(*) FROM orchestration_v2_projection_issue_work work
              JOIN orchestration_v2_projection_threads thread ON thread.thread_id = work.owner_thread_id
              WHERE work.host = ${issue.host} AND work.repository_id = ${issue.repositoryId}
                AND thread.thread_id <> ${threadId}
                AND ${usesWorkerSlot}) AS active,
            (WITH RECURSIVE ancestors(id, parent, payload) AS (
              SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId'), payload_json
                FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
              UNION ALL SELECT thread.thread_id, json_extract(thread.payload_json, '$.lineage.parentThreadId'), thread.payload_json
                FROM orchestration_v2_projection_threads thread JOIN ancestors ON thread.thread_id = ancestors.parent
            ) SELECT count(*) FROM ancestors JOIN json_each(root.payload_json, '$.repositoryOrchestration.suspendedIssues') suspended
              ON json_extract(suspended.value, '$.id') = json_extract(ancestors.payload, '$.linkedIssue.id')) AS suspended
          FROM orchestration_v2_projection_repository_orchestration owner
          JOIN orchestration_v2_projection_threads root ON root.thread_id = owner.root_thread_id
          WHERE owner.host = ${issue.host} AND owner.repository_id = ${issue.repositoryId}
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads worker
              WHERE worker.thread_id = ${threadId}
                AND json_extract(worker.payload_json, '$.lineage.rootThreadId') = owner.root_thread_id)
        `;
          const row = rows[0];
          return (
            row !== undefined &&
            row.lineage_valid === 1 &&
            (row.paused === 0 || row.draining === 1) &&
            row.suspended === 0 &&
            row.active < row.worker_limit
          );
        }).pipe(Effect.mapError(mapError)),
      request: (requestId) =>
        sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_issue_work_requests WHERE request_id = ${requestId}
    `.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined ? Effect.succeed(null) : decodeRequest(rows[0].payload_json),
          ),
          Effect.mapError(mapError),
        ),
      requestsForAttempt: (request) =>
        sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_issue_work_requests
          WHERE host = ${request.issue.host} AND repository_id = ${request.issue.repositoryId}
            AND issue_id = ${request.issue.id} AND attempt_key = ${request.attemptKey}
            AND root_thread_id = ${request.rootThreadId} AND json_type(payload_json, '$.cancellation') IS NULL
          ORDER BY rowid
        `.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRequest(row.payload_json))),
          Effect.mapError(mapError),
        ),
      latestRequest: (issue) =>
        sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_issue_work_requests
      WHERE lower(host) = lower(${issue.host}) AND lower(repository) = lower(${issue.repository}) AND issue_number = ${issue.number}
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined ? Effect.succeed(null) : decodeRequest(rows[0].payload_json),
          ),
          Effect.mapError(mapError),
        ),
      hasAttempt: (issue, attemptKey) =>
        sql<{ request_id: string }>`
      SELECT request_id FROM orchestration_v2_projection_issue_work_requests
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND issue_id = ${issue.id} AND attempt_key = ${attemptKey} AND json_type(payload_json, '$.cancellation') IS NULL LIMIT 1
    `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError),
        ),
      linkedIssue: (issue) =>
        sql<{
          host: string;
          repository_id: string;
          issue_id: string;
          issue_number: number;
          repository: string;
          node_id: string;
          issue_url: string;
          issue_title: string;
        }>`
      SELECT host, repository_id, issue_id, issue_number, repository, node_id, issue_url, issue_title
      FROM orchestration_v2_projection_issue_work
      WHERE lower(host) = lower(${issue.host ?? "github.com"}) AND lower(repository) = lower(${issue.repository}) AND issue_number = ${issue.number}
    `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? null
              : {
                  host: rows[0].host,
                  repositoryId: rows[0].repository_id,
                  id: rows[0].issue_id,
                  number: rows[0].issue_number,
                  repository: rows[0].repository,
                  nodeId: rows[0].node_id,
                  url: rows[0].issue_url,
                  title: rows[0].issue_title,
                },
          ),
          Effect.mapError(mapError),
        ),
      repositoryOwner: (issue) =>
        sql<RepositoryOwnerRow>`
      SELECT root_thread_id, project_id, paused, revision FROM orchestration_v2_projection_repository_orchestration
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId}
    `.pipe(Effect.map(ownerFromRows), Effect.mapError(mapError)),
      repositoryOwnerByRef: (issue) =>
        sql<RepositoryOwnerRow>`
      SELECT root_thread_id, project_id, paused, revision FROM orchestration_v2_projection_repository_orchestration owner
      WHERE lower(owner.host) = lower(${issue.host})
        AND (lower(owner.repository) = lower(${issue.repository}) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_issue_work_requests request
          WHERE request.host = owner.host AND request.repository_id = owner.repository_id
            AND lower(request.repository) = lower(${issue.repository})
        ))
      LIMIT 1
    `.pipe(Effect.map(ownerFromRows), Effect.mapError(mapError)),
      issueOwner: (issue) =>
        sql<{ owner_thread_id: string | null }>`
      SELECT owner_thread_id FROM orchestration_v2_projection_issue_work
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND issue_id = ${issue.id}
    `.pipe(
          Effect.map((rows) =>
            rows[0]?.owner_thread_id == null ? null : ThreadId.make(rows[0].owner_thread_id),
          ),
          Effect.mapError(mapError),
        ),
      currentIssueOwner: (issue) =>
        sql<{ owner_thread_id: string }>`
      SELECT work.owner_thread_id FROM orchestration_v2_projection_issue_work work
      JOIN orchestration_v2_projection_repository_orchestration repository
        ON repository.host = work.host AND repository.repository_id = work.repository_id
      JOIN orchestration_v2_projection_threads thread ON thread.thread_id = work.owner_thread_id
      WHERE work.host = ${issue.host} AND work.repository_id = ${issue.repositoryId} AND work.issue_id = ${issue.id}
        AND json_extract(thread.payload_json, '$.lineage.rootThreadId') = repository.root_thread_id
    `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined ? null : ThreadId.make(rows[0].owner_thread_id),
          ),
          Effect.mapError(mapError),
        ),
      hasUnclaimedRequests: (rootThreadId) =>
        sql<{ request_id: string }>`
      SELECT requests.request_id FROM orchestration_v2_projection_issue_work_requests requests
      LEFT JOIN orchestration_v2_projection_issue_work work
        ON work.host = requests.host AND work.repository_id = requests.repository_id AND work.issue_id = requests.issue_id
      WHERE requests.root_thread_id = ${rootThreadId} AND json_type(requests.payload_json, '$.cancellation') IS NULL AND (work.owner_thread_id IS NULL OR requests.attempt_key = work.owner_thread_id) LIMIT 1
    `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError),
        ),
      publishing: (threadId, issue) =>
        sql<{ status: string; last_error: string | null }>`
      SELECT status, last_error FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND (effect_type = 'issue.github.comment'
        OR (effect_type = 'issue.status.refresh' AND status IN ('pending', 'running', 'failed')))
        AND ${issue === undefined ? sql`1 = 1` : sql`json_extract(payload_json, '$.issue.host') = ${issue.host} AND json_extract(payload_json, '$.issue.repositoryId') = ${issue.repositoryId} AND json_extract(payload_json, '$.issue.id') = ${issue.id}`}
      ORDER BY created_at DESC
    `.pipe(
          Effect.map((rows) => {
            if (rows.length === 0) return "absent" as const;
            if (
              rows.some(
                (row) =>
                  row.status === "failed" ||
                  ((row.status === "pending" || row.status === "running") &&
                    row.last_error !== null),
              )
            )
              return "failed" as const;
            if (rows.some((row) => row.status === "pending" || row.status === "running"))
              return "pending" as const;
            return rows.some((row) => row.status === "succeeded")
              ? ("published" as const)
              : ("absent" as const);
          }),
          Effect.mapError(mapError),
        ),
    });
  }),
);
