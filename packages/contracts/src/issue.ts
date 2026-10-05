import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const IssueNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Host = TrimmedNonEmptyString.check(Schema.isMaxLength(253));
const Repository = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).check(
  Schema.isPattern(/^[^/\s]+\/[^/\s]+$/),
);
const Cursor = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const IssueUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048)).check(
  Schema.isPattern(/^https?:\/\/[^\s]+$/i),
);
/** Issues are scoped by repository, independent of which T3 projects are open. */
export const IssueRepositoryRef = Schema.Struct({
  host: Host,
  repository: Repository,
});
export type IssueRepositoryRef = typeof IssueRepositoryRef.Type;

export const IssueRef = Schema.Struct({ ...IssueRepositoryRef.fields, number: IssueNumber });
export type IssueRef = typeof IssueRef.Type;

export const IssueActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.NullOr(IssueUrl),
});
export type IssueActor = typeof IssueActor.Type;

export const IssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{6}$/iu))),
});
export type IssueLabel = typeof IssueLabel.Type;

export const IssueMilestone = Schema.Struct({
  number: IssueNumber,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  dueAt: Schema.NullOr(IsoDateTime),
  url: IssueUrl,
  openCount: NonNegativeInt,
  closedCount: NonNegativeInt,
});
export type IssueMilestone = typeof IssueMilestone.Type;

export const IssueSummary = Schema.Struct({
  number: IssueNumber,
  title: Schema.String,
  url: IssueUrl,
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.NullOr(Schema.String),
  author: Schema.NullOr(IssueActor),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  milestone: Schema.NullOr(IssueMilestone),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  commentCount: NonNegativeInt,
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueViewer = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
});
export type IssueViewer = typeof IssueViewer.Type;

export const IssueListState = Schema.Literals(["open", "all"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueListInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  state: Schema.optional(IssueListState),
  cursor: Schema.optional(Cursor),
});
export type IssueListInput = typeof IssueListInput.Type;

const IssueContext = {
  repository: IssueRepositoryRef,
  viewer: Schema.NullOr(IssueViewer),
  fetchedAt: IsoDateTime,
};

export const IssueListResult = Schema.Struct({
  ...IssueContext,
  issues: Schema.Array(IssueSummary),
  milestones: Schema.Array(IssueMilestone),
  nextCursor: Schema.NullOr(Cursor),
  issuesComplete: Schema.Boolean,
  milestonesComplete: Schema.Boolean,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRepositorySummary = Schema.Struct({
  ...IssueRepositoryRef.fields,
  owner: TrimmedNonEmptyString,
  ownerIsOrganization: Schema.Boolean,
  isPrivate: Schema.Boolean,
  isArchived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  isFork: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** GitHub's open_issues_count, which also counts open pull requests. */
  openIssuesAndPullRequests: NonNegativeInt,
  pushedAt: Schema.NullOr(IsoDateTime),
});
export type IssueRepositorySummary = typeof IssueRepositorySummary.Type;

export const IssueRepositoriesResult = Schema.Struct({
  viewer: IssueViewer,
  repositories: Schema.Array(IssueRepositorySummary),
  complete: Schema.Boolean,
  fetchedAt: IsoDateTime,
});
export type IssueRepositoriesResult = typeof IssueRepositoriesResult.Type;

export const IssueDetailInput = Schema.Struct({
  ...IssueRef.fields,
  expectedAccountId: Schema.optional(TrimmedNonEmptyString),
});
export type IssueDetailInput = typeof IssueDetailInput.Type;

export const IssueComment = Schema.Struct({
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: IssueUrl,
});
export type IssueComment = typeof IssueComment.Type;

/** A pull request that closes the issue or mentions it in its timeline. */
export const IssueLinkedPullRequest = Schema.Struct({
  /** `owner/name`, which can differ from the issue's repository. */
  repository: Repository,
  number: IssueNumber,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  url: IssueUrl,
  closesIssue: Schema.Boolean,
});
export type IssueLinkedPullRequest = typeof IssueLinkedPullRequest.Type;

export const IssueDetailResult = Schema.Struct({
  ...IssueContext,
  issue: IssueSummary,
  body: Schema.String,
  /**
   * The most recent comments, oldest first. Fewer than `issue.commentCount` means older ones
   * were left out.
   */
  comments: Schema.Array(IssueComment).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  linkedPullRequests: Schema.Array(IssueLinkedPullRequest).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type IssueDetailResult = typeof IssueDetailResult.Type;

export class IssueReadError extends Schema.TaggedError<IssueReadError>()("IssueReadError", {
  code: Schema.Literals([
    "unsupported",
    "scope-unavailable",
    "missing-tool",
    "unauthenticated",
    "verification-unavailable",
    "inaccessible",
    "rate-limited",
    "invalid-cursor",
    "invalid-response",
    "upstream",
  ]),
  operation: Schema.Literals(["repositories", "list", "detail"]),
  message: Schema.String,
  retryAt: Schema.optional(Schema.Finite),
}) {}
