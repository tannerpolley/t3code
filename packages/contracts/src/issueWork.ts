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
  handoff: Schema.optional(
    Schema.Struct({
      requestId: CommandId,
      nextThreadId: ThreadId,
      summary: TrimmedNonEmptyString,
      modelSelection: ModelSelection,
      status: Schema.Literals(["awaiting_approval", "draining"]),
      wasPaused: Schema.Boolean,
    }),
  ),
  handoffHistory: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        transferredAt: Schema.String,
      }),
    ),
  ),
  retiredToThreadId: Schema.optional(ThreadId),
});
export type RepositoryOrchestration = typeof RepositoryOrchestration.Type;
export const DEFAULT_REPOSITORY_WORK_SETTINGS = {
  workerLimit: 4,
  publishStatusComments: true,
  publishCloseoutComments: true,
} as const;

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
export const RepositoryHandoffRequestInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  summary: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  clientRequestId: CommandId,
});
export type RepositoryHandoffRequestInput = typeof RepositoryHandoffRequestInput.Type;
export const RepositoryHandoffInput = Schema.Union([
  Schema.Struct({ ...RepositoryHandoffRequestInput.fields, action: Schema.Literal("approve") }),
  Schema.Struct({
    ...IssueRepositoryRef.fields,
    expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    clientRequestId: CommandId,
    action: Schema.Literal("cancel"),
  }),
]);
export type RepositoryHandoffInput = typeof RepositoryHandoffInput.Type;
/** User-only recovery; expectations prevent overwriting a newer repository owner. */
export const RepositoryWorkRestoreInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  repositoryId: TrimmedNonEmptyString,
  projectId: ProjectId,
  expectedRootThreadId: Schema.NullOr(ThreadId),
  expectedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  targetThreadId: ThreadId,
  reason: TrimmedNonEmptyString,
  clientRequestId: CommandId,
});
export type RepositoryWorkRestoreInput = typeof RepositoryWorkRestoreInput.Type;
/** Cancels one unclaimed admission, including duplicate requests coalesced into the same attempt. */
export const IssueWorkCancelInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  projectId: ProjectId,
  expectedRootThreadId: ThreadId,
  requestId: CommandId,
  reason: TrimmedNonEmptyString,
  clientRequestId: CommandId,
});
export type IssueWorkCancelInput = typeof IssueWorkCancelInput.Type;
const IssueWorkCancellation = Schema.Struct({
  commandId: CommandId,
  reason: TrimmedNonEmptyString,
  cancelledAt: Schema.String,
});
export const IssueWorkCancelled = Schema.Struct({
  requestedRequestId: CommandId,
  requestId: CommandId,
  issue: ThreadLinkedIssue,
  cancellation: IssueWorkCancellation,
});
export const RepositoryWorkRestored = Schema.Struct({
  previousRootThreadId: Schema.NullOr(ThreadId),
  targetThreadId: ThreadId,
  expectedRevision: Schema.NullOr(Schema.Int),
  reason: TrimmedNonEmptyString,
  /** The restored owner. A registration (no previous root) projects it as the first owner. */
  repositoryOrchestration: RepositoryOrchestration,
});

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
  /** Selected existing lead; otherwise reuse the registered owner or explicitly create the first one. */
  orchestratorThreadId: Schema.optional(ThreadId),
  /** Explicit consent to create the first orchestrator when none is registered. */
  createOrchestrator: Schema.optional(Schema.Boolean),
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
  /** The issue's unclaimed Start request on the current root, which the user may cancel. */
  pendingRequestId: Schema.optional(Schema.NullOr(CommandId)),
});
export type IssueWorkStatusResult = typeof IssueWorkStatusResult.Type;

export class IssueWorkError extends Schema.TaggedError<IssueWorkError>()("IssueWorkError", {
  code: Schema.Literals([
    "invalid-request",
    "issue-unavailable",
    "repository-owner-conflict",
    "retired-root",
    "orchestration-error",
  ]),
  message: Schema.String,
}) {}

/** Accepted request identity survives completion so retries cannot launch a successor. */
export const IssueWorkRequested = Schema.Struct({
  requestId: CommandId,
  issue: ThreadLinkedIssue,
  parent: Schema.optional(Schema.NullOr(ThreadLinkedIssue)),
  rootThreadId: ThreadId,
  issueThreadId: Schema.NullOr(ThreadId),
  attemptKey: Schema.String,
  modelSelection: ModelSelection,
  workspace: Schema.Literals(["project", "worktree"]),
  cancellation: Schema.optional(IssueWorkCancellation),
});
export type IssueWorkRequested = typeof IssueWorkRequested.Type;
