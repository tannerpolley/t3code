import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { IssueRef, IssueRepositoryRef, IssueReadError } from "./issue.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";

const Number = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: globalThis.Number.MAX_SAFE_INTEGER }),
);
const Body = Schema.String.check(Schema.isMaxLength(60_000));
const Draft = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  body: Body,
  milestoneNumber: Schema.NullOr(Number),
});
export const IssueChangeOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    ...Draft.fields,
    parentNumber: Schema.optional(Number),
  }),
  Schema.Struct({
    type: Schema.Literal("split"),
    number: Number,
    issues: Schema.Array(Draft).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  Schema.Struct({ type: Schema.Literal("body"), number: Number, body: Body }),
  Schema.Struct({
    type: Schema.Literal("milestone"),
    number: Number,
    milestoneNumber: Schema.NullOr(Number),
  }),
  Schema.Struct({
    type: Schema.Literal("state"),
    number: Number,
    state: Schema.Literals(["open", "closed"]),
  }),
  Schema.Struct({
    type: Schema.Literal("sub_issue"),
    number: Number,
    childNumber: Number,
    action: Schema.Literals(["add", "remove"]),
  }),
]);
export type IssueChangeOperation = typeof IssueChangeOperation.Type;
export const IssueChangeProposeInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  operation: IssueChangeOperation,
});
export type IssueChangeProposeInput = typeof IssueChangeProposeInput.Type;
export const IssueChangeBaseline = Schema.Struct({
  issue: ThreadLinkedIssue,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  milestoneNumber: Schema.NullOr(Number),
});
export type IssueChangeBaseline = typeof IssueChangeBaseline.Type;
export const IssueChange = Schema.Struct({
  id: TrimmedNonEmptyString,
  ...IssueChangeProposeInput.fields,
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
  IssueRef,
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
