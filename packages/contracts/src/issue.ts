import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString, ThreadId } from "./baseSchemas.ts";
import { ThreadLinkedIssue } from "./threadIssue.ts";
import { PullRequestState } from "./pullRequest.ts";
import { ThreadRole } from "./threadRole.ts";

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

/** Closing references and visible pull requests of linked threads, deduplicated by identity. */
export const IssuePullRequest = Schema.Struct({
  ...IssueRef.fields,
  url: IssueUrl,
  title: Schema.String,
  /** Null until a linked thread's pull request has its first host snapshot. */
  state: Schema.NullOr(PullRequestState),
  isDraft: Schema.Boolean,
  updatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type IssuePullRequest = typeof IssuePullRequest.Type;

const IssueWorkStatus = Schema.Struct({
  threadId: ThreadId,
  /** Descendant work is visible, but only the directly linked thread drives running status. */
  inherited: Schema.optional(Schema.Boolean),
  status: Schema.Literals(["working", "waiting_on_you", "idle"]),
});

export const IssueSummary = Schema.Struct({
  suspensionReason: Schema.optional(Schema.String),
  number: IssueNumber,
  title: Schema.String,
  url: IssueUrl,
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.NullOr(Schema.String),
  author: Schema.NullOr(IssueActor),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  /** Optional for compatibility with servers that predate GitHub Project fields. */
  projects: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        title: TrimmedNonEmptyString,
        status: Schema.NullOr(TrimmedNonEmptyString),
        priority: Schema.NullOr(
          Schema.Struct({
            name: TrimmedNonEmptyString,
            /** Index in the Project's Priority options; unknown options have no rank. */
            rank: Schema.NullOr(NonNegativeInt),
          }),
        ),
      }),
    ),
  ),
  /** Native GitHub relationships; absent on older servers or inaccessible reads. */
  blockedBy: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...IssueRef.fields,
        state: Schema.Literals(["open", "closed"]),
      }),
    ),
  ),
  parent: Schema.optional(Schema.NullOr(IssueRef)),
  relationshipsComplete: Schema.optional(Schema.Boolean),
  /** Closing PR references, read with the list's metadata batch. */
  pullRequestRefs: Schema.optional(Schema.Array(IssueRef)),
  /** Count of the deduplicated closing and linked-thread pull requests. */
  pullRequestCount: Schema.optional(NonNegativeInt),
  pullRequests: Schema.optional(Schema.Array(IssuePullRequest)),
  /** GitHub closing references only; thread PRs are added from current associations. */
  closingPullRequests: Schema.optional(Schema.Array(IssuePullRequest)),
  /** GitHub's sub-issue tally; absent on older servers and hosts without sub-issues. */
  subIssues: Schema.optional(Schema.Struct({ total: NonNegativeInt, completed: NonNegativeInt })),
  liveWork: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...IssueWorkStatus.fields,
        /** An ordinary issue link, removable without altering managed work or PRs. */
        canUnlink: Schema.optional(Schema.Boolean),
        title: Schema.String,
        /** Absent from older servers and threads without an assigned role. */
        role: Schema.optional(ThreadRole),
        branch: Schema.NullOr(Schema.String),
        worktreePath: Schema.NullOr(Schema.String),
        worktreeExists: Schema.optional(Schema.Boolean),
        pullRequests: Schema.Array(Schema.String),
      }),
    ),
  ),
  milestone: Schema.NullOr(IssueMilestone),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  commentCount: NonNegativeInt,
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueViewer = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
});
export type IssueViewer = typeof IssueViewer.Type;

/** PR identity and observation time keep sidebar status consistent with streamed thread PRs. */
export const IssuePullRequestStatus = Schema.Struct({
  ...IssueRef.fields,
  state: IssuePullRequest.fields.state,
  updatedAt: IssuePullRequest.fields.updatedAt,
});
export type IssuePullRequestStatus = typeof IssuePullRequestStatus.Type;

export const IssueStatusBatchInput = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      host: ThreadLinkedIssue.fields.host,
      nodeId: ThreadLinkedIssue.fields.nodeId,
    }),
  ),
});
export type IssueStatusBatchInput = typeof IssueStatusBatchInput.Type;

export const IssueStatusBatchResult = Schema.Array(
  Schema.Struct({
    host: Host,
    nodeId: ThreadLinkedIssue.fields.nodeId,
    suspensionReason: IssueSummary.fields.suspensionReason,
    state: IssueSummary.fields.state,
    stateReason: IssueSummary.fields.stateReason,
    blockedBy: Schema.Array(Schema.Struct({ state: IssueSummary.fields.state })),
    pullRequests: Schema.Array(IssuePullRequestStatus),
    closingPullRequests: Schema.optional(Schema.Array(IssuePullRequestStatus)),
    liveWork: Schema.optional(Schema.Array(IssueWorkStatus)),
  }),
);
export type IssueStatusBatchResult = typeof IssueStatusBatchResult.Type;

export const IssueListState = Schema.Literals(["open", "all"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueListInput = Schema.Struct({
  ...IssueRepositoryRef.fields,
  state: Schema.optional(IssueListState),
  roadmap: Schema.optional(Schema.Boolean),
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

export const IssueWorkRead = Schema.Struct({
  issue: ThreadLinkedIssue,
  state: Schema.Literals(["open", "closed"]),
  milestoneNumber: Schema.NullOr(IssueNumber),
  parent: Schema.NullOr(ThreadLinkedIssue),
  subIssues: Schema.Array(ThreadLinkedIssue),
  blockedBy: Schema.Array(
    Schema.Struct({ issue: ThreadLinkedIssue, state: Schema.Literals(["open", "closed"]) }),
  ),
  parentComplete: Schema.Boolean,
  subIssuesComplete: Schema.Boolean,
  blockersComplete: Schema.Boolean,
});
export type IssueWorkRead = typeof IssueWorkRead.Type;

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
  /** Create failures distinguish a rejected request from an uncertain remote write. */
  createOutcome: Schema.optional(Schema.Literals(["rejected", "uncertain", "unresolved"])),
  operation: Schema.Literals(["repositories", "list", "detail"]),
  message: Schema.String,
  retryAt: Schema.optional(Schema.Finite),
}) {}
