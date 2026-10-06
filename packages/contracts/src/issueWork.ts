import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";
import { IssueRef, IssueRepositoryRef } from "./issue.ts";

export const RepositoryMilestonePlan = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  modelRoleId: TrimmedNonEmptyString,
  workspace: Schema.Literals(["project", "worktree"]),
  status: Schema.Literals(["running", "complete", "blocked", "awaiting_approval", "unreadable"]),
  fingerprint: Schema.String,
});

export const RepositoryOrchestration = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  projectId: ProjectId,
  workspace: Schema.Literals(["project", "worktree"]),
  launchCommandId: CommandId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  paused: Schema.Boolean,
  workerLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  publishStatusComments: Schema.Boolean,
  publishCloseoutComments: Schema.Boolean,
  milestones: Schema.Array(RepositoryMilestonePlan).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  suspendedIssues: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type RepositoryOrchestration = typeof RepositoryOrchestration.Type;
export const RepositoryWorkTarget = Schema.Struct({
  host: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
});

export const RepositoryWorkInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  projectId: ProjectId,
  modelRoleId: TrimmedNonEmptyString,
  workspace: Schema.Literals(["project", "worktree"]),
  milestoneNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  clientRequestId: CommandId,
});
export type RepositoryWorkInput = typeof RepositoryWorkInput.Type;
export const RepositoryWorkControlInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  paused: Schema.Boolean,
  clientRequestId: CommandId,
});
export type RepositoryWorkControlInput = typeof RepositoryWorkControlInput.Type;
export const RepositoryWorkResult = Schema.Struct({
  rootThreadId: Schema.NullOr(ThreadId),
  orchestration: Schema.NullOr(RepositoryOrchestration),
});
export type RepositoryWorkResult = typeof RepositoryWorkResult.Type;

export const IssueWorkStartInput = Schema.Struct({
  ...IssueRef.fields,
  projectId: ProjectId,
  modelRoleId: TrimmedNonEmptyString,
  workspace: Schema.Literals(["project", "worktree"]),
  clientRequestId: CommandId,
});
export type IssueWorkStartInput = typeof IssueWorkStartInput.Type;

export const IssueWorkStatus = Schema.Literals([
  "queued_preparing",
  "working",
  "waiting_on_you",
  "waiting_on_sub_issues",
  "done",
  "failed",
  "interrupted",
  "cancelled",
  "paused",
  "unavailable",
]);
export type IssueWorkStatus = typeof IssueWorkStatus.Type;

export const ISSUE_WORK_STATUS_LABELS = {
  queued_preparing: "Queued / preparing",
  working: "Working",
  waiting_on_you: "Waiting on you",
  waiting_on_sub_issues: "Waiting on sub-issues",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  paused: "Paused",
  unavailable: "Unavailable",
} satisfies Record<IssueWorkStatus, string>;

export const IssueWorkStartResult = Schema.Struct({
  rootThreadId: ThreadId,
  issueThreadId: Schema.NullOr(ThreadId),
  status: IssueWorkStatus,
  createdRoot: Schema.Boolean,
});
export type IssueWorkStartResult = typeof IssueWorkStartResult.Type;

export const IssueWorkStatusInput = Schema.Struct({
  ...IssueRef.fields,
});
export type IssueWorkStatusInput = typeof IssueWorkStatusInput.Type;

export const IssueWorkStatusResult = Schema.Struct({
  issue: IssueRef,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  rootThreadId: Schema.NullOr(ThreadId),
  threadId: Schema.NullOr(ThreadId),
  status: Schema.NullOr(IssueWorkStatus),
  publishing: Schema.Literals(["absent", "pending", "published", "failed"]),
});
export type IssueWorkStatusResult = typeof IssueWorkStatusResult.Type;

export class IssueWorkError extends Schema.TaggedError<IssueWorkError>()("IssueWorkError", {
  code: Schema.Literals([
    "invalid-request",
    "issue-unavailable",
    "repository-owner-conflict",
    "orchestration-error",
  ]),
  message: Schema.String,
}) {}

/** Accepted request identity survives completion so retries cannot launch a successor. */
export const IssueWorkRequested = Schema.Struct({
  requestId: CommandId,
  issue: ThreadLinkedIssue,
  rootThreadId: ThreadId,
  issueThreadId: Schema.NullOr(ThreadId),
  attemptKey: Schema.String,
  modelSelection: ModelSelection,
  workspace: Schema.Literals(["project", "worktree"]),
});
export type IssueWorkRequested = typeof IssueWorkRequested.Type;
