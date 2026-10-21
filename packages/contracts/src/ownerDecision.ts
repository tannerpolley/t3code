import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueRef } from "./issue.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const OptionId = Id.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/u));
export const OwnerDecisionRequest = Schema.Struct({
  ...IssueRef.fields,
  clientRequestId: Id,
  question: Text,
  options: Schema.Array(Schema.Struct({ id: OptionId, label: Text, consequence: Text })).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(4),
  ),
  recommendedOptionId: OptionId,
  recommendationReason: Text,
  evidenceUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(2048),
    Schema.isPattern(/^https?:\/\/[^\s]+$/iu),
  ),
});
export type OwnerDecisionRequest = typeof OwnerDecisionRequest.Type;
const Comment = Schema.Struct({ id: Schema.String, url: Schema.String });
export const OwnerDecision = Schema.Struct({
  ...OwnerDecisionRequest.fields,
  id: Id,
  requestingThreadId: ThreadId,
  requestingThreadTitle: Schema.String,
  requestingProjectId: ProjectId,
  requestingProjectTitle: Schema.String,
  state: Schema.Literals([
    "publishing",
    "awaiting_choice",
    "answered",
    "withdrawn",
    "publication_failed",
    "publication_mismatch",
    "delivery_failed",
  ]),
  requestComment: Schema.NullOr(Comment),
  choiceComment: Schema.NullOr(Comment),
  chosenOptionId: Schema.NullOr(OptionId),
  chosenBy: Schema.NullOr(Schema.String),
  chosenAt: Schema.NullOr(IsoDateTime),
  withdrawalReason: Schema.NullOr(Text),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
  deliveryThreadId: Schema.NullOr(ThreadId),
  pendingPublish: Schema.NullOr(Schema.Literals(["request", "choice", "withdrawn"])),
  pendingDelivery: Schema.Boolean,
  pendingLabel: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type OwnerDecision = typeof OwnerDecision.Type;
export const OwnerDecisionsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(IssueRef.fields.host),
  repository: Schema.optional(IssueRef.fields.repository),
  number: Schema.optional(IssueRef.fields.number),
});
export type OwnerDecisionsListInput = typeof OwnerDecisionsListInput.Type;
export const OwnerDecisionChooseInput = Schema.Struct({ id: Id, optionId: OptionId });
export type OwnerDecisionChooseInput = typeof OwnerDecisionChooseInput.Type;
export const OwnerDecisionWithdrawInput = Schema.Struct({ id: Id, reason: Text });
export type OwnerDecisionWithdrawInput = typeof OwnerDecisionWithdrawInput.Type;
export class OwnerDecisionError extends Schema.TaggedError<OwnerDecisionError>()(
  "OwnerDecisionError",
  {
    code: Schema.Literals([
      "invalid-request",
      "forbidden",
      "storage",
      "github",
      "publication-mismatch",
      "delivery",
      "delivery-unavailable",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
