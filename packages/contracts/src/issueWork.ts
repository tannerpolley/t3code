import * as Schema from "effect/Schema";

import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";
import { IssueRef } from "./issue.ts";

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
});
export type RepositoryOrchestration = typeof RepositoryOrchestration.Type;

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
