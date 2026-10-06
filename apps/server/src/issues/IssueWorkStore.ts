import {
  IssueWorkError,
  IssueWorkRequested,
  ProjectId,
  ThreadId,
  type CommandId,
  type IssueRef,
  type ThreadLinkedIssue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type RepositoryOwner = {
  readonly rootThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly paused: boolean;
};
type RepositoryOwnerRow = {
  readonly root_thread_id: string;
  readonly project_id: string;
  readonly paused: number;
};
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(IssueWorkRequested));
const ownerFromRows = (rows: ReadonlyArray<RepositoryOwnerRow>): RepositoryOwner | null =>
  rows[0] === undefined
    ? null
    : {
        rootThreadId: ThreadId.make(rows[0].root_thread_id),
        projectId: ProjectId.make(rows[0].project_id),
        paused: rows[0].paused === 1,
      };

/** Reads ownership projected by committed orchestration events. Never claims outside the event sink. */
export class IssueWorkStore extends Context.Service<
  IssueWorkStore,
  {
    readonly request: (
      requestId: CommandId,
    ) => Effect.Effect<import("@t3tools/contracts").IssueWorkRequested | null, IssueWorkError>;
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
      issue: IssueRef,
    ) => Effect.Effect<RepositoryOwner | null, IssueWorkError>;
    readonly issueOwner: (
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
    return IssueWorkStore.of({
      request: (requestId) =>
        sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_issue_work_requests WHERE request_id = ${requestId}
    `.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined ? Effect.succeed(null) : decodeRequest(rows[0].payload_json),
          ),
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
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId} AND issue_id = ${issue.id} AND attempt_key = ${attemptKey} LIMIT 1
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
      SELECT root_thread_id, project_id, paused FROM orchestration_v2_projection_repository_orchestration
      WHERE host = ${issue.host} AND repository_id = ${issue.repositoryId}
    `.pipe(Effect.map(ownerFromRows), Effect.mapError(mapError)),
      repositoryOwnerByRef: (issue) =>
        sql<RepositoryOwnerRow>`
      SELECT root_thread_id, project_id, paused FROM orchestration_v2_projection_repository_orchestration owner
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
      hasUnclaimedRequests: (rootThreadId) =>
        sql<{ request_id: string }>`
      SELECT requests.request_id FROM orchestration_v2_projection_issue_work_requests requests
      LEFT JOIN orchestration_v2_projection_issue_work work
        ON work.host = requests.host AND work.repository_id = requests.repository_id AND work.issue_id = requests.issue_id
      WHERE requests.root_thread_id = ${rootThreadId} AND (work.owner_thread_id IS NULL OR requests.attempt_key = work.owner_thread_id) LIMIT 1
    `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(mapError),
        ),
      publishing: (threadId, issue) =>
        sql<{ status: string; last_error: string | null }>`
      SELECT status, last_error FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'issue.github.comment'
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
