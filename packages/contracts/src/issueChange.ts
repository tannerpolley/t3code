import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import {
  GITHUB_ISSUE_STATUSES,
  RepositoryIssueRef,
  IssueRepositoryRef,
  IssueReadError,
} from "./repositoryIssue.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";

const Number = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: globalThis.Number.MAX_SAFE_INTEGER }),
);
const Body = Schema.String.check(Schema.isMaxLength(60_000));
const Draft = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  body: Body,
  initialStatus: Schema.optional(Schema.Literals(["Todo", "Backlog"])),
  needsOwnerDecision: Schema.optional(Schema.Boolean),
});
const StoredDraft = Schema.Struct({
  ...Draft.fields,
  milestoneNumber: Schema.optional(Schema.NullOr(Number)),
});
const create = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({
    type: Schema.Literal("create"),
    ...fields,
    parentNumber: Schema.optional(Number),
  });
const split = <S extends typeof Draft | typeof StoredDraft>(draft: S) =>
  Schema.Struct({
    type: Schema.Literal("split"),
    number: Number,
    issues: Schema.Array(draft).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  });
const sharedOperations = [
  Schema.Struct({ type: Schema.Literal("body"), number: Number, body: Body }),
  Schema.Struct({
    type: Schema.Literal("state"),
    number: Number,
    state: Schema.Literals(["open", "closed"]),
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    number: Number,
    status: Schema.Literals(GITHUB_ISSUE_STATUSES),
    clearOrchestratorHold: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("sub_issue"),
    number: Number,
    childNumber: Number,
    action: Schema.Literals(["add", "remove"]),
  }),
  Schema.Struct({
    type: Schema.Literal("blocked_by"),
    number: Number,
    blockerNumber: Number,
    action: Schema.Literals(["add", "remove"]),
  }),
] as const;
export const IssueChangeOperation = Schema.Union([
  create(StoredDraft.fields),
  split(StoredDraft),
  Schema.Struct({
    type: Schema.Literal("milestone"),
    number: Number,
    milestoneNumber: Schema.NullOr(Number),
  }),
  ...sharedOperations,
]);
export type IssueChangeOperation = typeof IssueChangeOperation.Type;
export const IssueChangeProposeInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  operation: Schema.Union([create(Draft.fields), split(Draft), ...sharedOperations]),
});
export type IssueChangeProposeInput = typeof IssueChangeProposeInput.Type;
export const IssueChangeBaseline = Schema.Struct({
  issue: ThreadLinkedIssue,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  planningStatus: Schema.optional(Schema.String),
  milestoneNumber: Schema.NullOr(Number),
});
export type IssueChangeBaseline = typeof IssueChangeBaseline.Type;
export const IssueChange = Schema.Struct({
  id: TrimmedNonEmptyString,
  ...IssueChangeProposeInput.fields,
  operation: IssueChangeOperation,
  requestingThreadId: ThreadId,
  baseline: Schema.NullOr(IssueChangeBaseline),
  childBaseline: Schema.NullOr(ThreadLinkedIssue),
  diff: Schema.NullOr(Schema.String),
  t3AuthoredBody: Schema.Boolean,
  decision: Schema.Literals(["pending", "auto_approved", "approved", "rejected"]),
  decidedBy: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "pending",
    "queued",
    "executing",
    "succeeded",
    "failed",
    "conflict",
    "needs_attention",
    "resolved",
    "rejected",
  ]),
  completedSteps: Schema.Record(
    Schema.String,
    Schema.Struct({ issue: Schema.optional(ThreadLinkedIssue) }),
  ),
  result: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type IssueChange = typeof IssueChange.Type;
export const IssueChangesListInput = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  RepositoryIssueRef,
]);
export type IssueChangesListInput = typeof IssueChangesListInput.Type;
export const IssueChangeDecisionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  decision: Schema.Literals(["approved", "rejected", "retry", "resolved"]),
});
export type IssueChangeDecisionInput = typeof IssueChangeDecisionInput.Type;
export class IssueChangeError extends Schema.TaggedError<IssueChangeError>()("IssueChangeError", {
  code: Schema.Literals(["invalid-request", "forbidden", "storage", "github"]),
  createOutcome: IssueReadError.fields.createOutcome,
  message: Schema.String,
  retryAt: Schema.optional(Schema.Finite),
}) {}
