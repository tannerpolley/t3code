import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ISSUE_HOSTS,
  IsoDateTime,
  IssueMilestone,
  IssueReadError,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type IssueStatusBatchResult,
  type RepositoryIssueListState,
  type IssueRepositoriesResult as IssueRepositoriesResultType,
  type IssueRepositorySummary,
  type RepositoryIssueSummary as IssueSummaryType,
  ThreadLinkedIssue,
  type IssueWorkRead,
  type IssueDetailInput as IssueDetailInputType,
  type IssueHostCapabilities,
  type IssueChangeBaseline,
  type IssueRepositoryRef,
  type RepositoryIssueRef,
  type ThreadLinkedIssue as ThreadLinkedIssueType,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubApi from "./IssueGitHubApi.ts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import { readIssueListMetadata, type ProjectAccess } from "./IssueProjects.ts";

export interface IssueRepositoryScope {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
}

export interface PageResult<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextPage: number | null;
  readonly etag?: string | undefined;
  readonly generation?: number;
}

export type ListMetadata = Map<
  number,
  Partial<
    Pick<
      IssueSummaryType,
      | "projects"
      | "parent"
      | "blockedBy"
      | "subIssues"
      | "relationshipsComplete"
      | "pullRequestRefs"
      | "pullRequests"
      | "milestone"
      | "subIssues"
    >
  >
>;
export type PageResponse<A> =
  | PageResult<A>
  | {
      readonly notModified: true;
      readonly nextPage: number | null | undefined;
      readonly etag: string | undefined;
    };

export type IssuePageResult = PageResult<IssueSummaryType>;

export interface IssueHostIdentity {
  readonly accountId: string;
  readonly viewer: string;
  readonly credentialFingerprint: string;
}
interface InboxActor {
  readonly login: string;
  readonly type?: string | undefined;
}
interface InboxIssue {
  readonly number: number;
  readonly title: string;
  readonly state?: "open" | "closed" | undefined;
  readonly body?: string | null | undefined;
  readonly user?: InboxActor | null | undefined;
  readonly labels?: ReadonlyArray<{ readonly name: string }> | null | undefined;
  readonly milestone?: { readonly number: number } | null | undefined;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly pull_request?: unknown | undefined;
}
interface InboxComment {
  readonly id: number;
  readonly body?: string | null | undefined;
  readonly user?: InboxActor | null | undefined;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly issue_url: string;
}
interface InboxEvent {
  readonly id: number;
  readonly event: string;
  readonly created_at: string;
  readonly issue?: { readonly number: number; readonly pull_request?: unknown } | null | undefined;
}
interface InboxPosted {
  readonly id: number;
  readonly number?: number | undefined;
  readonly html_url: string;
}
interface InboxListedComment {
  readonly id: number;
  readonly body: string | null;
  readonly html_url: string;
}
interface ActivityCursors {
  readonly issuesSince: string;
  readonly commentsSince: string;
  readonly eventsAfter: number;
  readonly issuesEtag: string | null;
  readonly commentsEtag: string | null;
  readonly eventsEtag: string | null;
  readonly initial?: boolean;
}
interface ActivityPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly etag: string | null;
  readonly complete: boolean;
}

export interface IssuePullRequestFacts {
  readonly state: "open" | "closed" | "merged";
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha?: string | null | undefined;
}

/** The GitHub facts and writes upstream's IssueService has no operation for. */
export interface IssueGitHubExtension {
  readonly capabilities: IssueHostCapabilities;
  readonly withRepositoryCredential: <A, E, R>(
    input: IssueRepositoryRef,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | IssueReadError, R>;
  readonly readChangeState: (
    input: import("@t3tools/contracts").RepositoryIssueRef,
  ) => Effect.Effect<IssueChangeBaseline, IssueReadError>;
  /**
   * The issue an earlier create made, found by the marker its body carries. Null when none has
   * it; fails when the search cannot finish, so a create is never repeated on a partial read.
   */
  readonly findCreatedIssue: (
    input: IssueRepositoryRef & { readonly marker: string },
  ) => Effect.Effect<IssueChangeBaseline | null, IssueReadError>;
  readonly setMilestone: (
    input: import("@t3tools/contracts").RepositoryIssueRef & {
      readonly milestoneNumber: number | null;
    },
  ) => Effect.Effect<void, IssueReadError>;
  readonly setParent: (input: {
    readonly parent: ThreadLinkedIssueType;
    readonly child: ThreadLinkedIssueType;
    readonly action: "add" | "remove";
  }) => Effect.Effect<void, IssueReadError>;
  readonly setBlockedBy: (input: {
    readonly issue: ThreadLinkedIssueType;
    readonly blocker: ThreadLinkedIssueType;
    readonly action: "add" | "remove";
  }) => Effect.Effect<void, IssueReadError>;
  readonly pullRequest: (
    input: RepositoryIssueRef & { readonly cwd: string },
  ) => Effect.Effect<IssuePullRequestFacts, IssueReadError>;
  readonly repositories: () => Effect.Effect<IssueRepositoriesResultType, IssueReadError>;

  readonly withIdentity: <A, R>(
    scope: IssueRepositoryScope,
    operation: IssueReadError["operation"],
    read: (identity: IssueHostIdentity) => Effect.Effect<A, IssueReadError, R>,
  ) => Effect.Effect<A, IssueReadError, R>;
  readonly listIssuePage: (
    scope: IssueRepositoryScope,
    state: RepositoryIssueListState,
    page: number,
    milestoneNumber?: number,
    etag?: string,
  ) => Effect.Effect<PageResponse<IssueSummaryType> & { readonly missing?: true }, IssueReadError>;
  readonly listMilestonePage: (
    scope: IssueRepositoryScope,
    state: RepositoryIssueListState,
    page: number,
    etag?: string,
  ) => Effect.Effect<PageResponse<IssueMilestone>, IssueReadError>;
  readonly listMetadata: (
    scope: IssueRepositoryScope,
    numbers: ReadonlyArray<number>,
    projectAccess: ProjectAccess,
  ) => Effect.Effect<Option.Option<ListMetadata>>;
  readonly statuses: (
    host: string,
    nodeIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<IssueStatusBatchResult[number] & RepositoryIssueRef>,
    IssueReadError
  >;
  readonly workRead: (input: IssueDetailInputType) => Effect.Effect<IssueWorkRead, IssueReadError>;
  readonly repositoryIdentity: (input: {
    readonly host: string;
    readonly repository: string;
  }) => Effect.Effect<
    Pick<ThreadLinkedIssueType, "host" | "repository" | "repositoryId">,
    IssueReadError
  >;
  readonly resolveLinkedIssue: (input: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<ThreadLinkedIssueType, IssueReadError>;
  /** The issue's comment carrying `marker`, or null when none does. */
  readonly findManagedComment: (input: {
    readonly issue: ThreadLinkedIssueType;
    readonly marker: string;
  }) => Effect.Effect<{ readonly id: string; readonly body: string | null } | null, IssueReadError>;
  /** Rewrites a comment T3 wrote; upstream can only add comments. */
  readonly updateManagedComment: (input: {
    readonly issue: ThreadLinkedIssueType;
    readonly commentId: string;
    readonly body: string;
  }) => Effect.Effect<void, IssueReadError>;
  readonly activitySince: (
    scope: IssueRepositoryRef,
    cursors: ActivityCursors,
  ) => Effect.Effect<
    {
      readonly issues: ActivityPage<InboxIssue>;
      readonly comments: ActivityPage<InboxComment>;
      readonly stateChanges: ActivityPage<InboxEvent>;
      readonly eventsAfter: number;
    },
    IssueReadError
  >;
  readonly listComments: (
    ref: RepositoryIssueRef,
    options?: {
      readonly maxPages?: number;
      /** Stops reading further pages once the comments read so far satisfy it. */
      readonly until?: (comments: ReadonlyArray<InboxListedComment>) => boolean;
    },
  ) => Effect.Effect<
    {
      readonly comments: ReadonlyArray<InboxListedComment>;
      readonly complete: boolean;
    },
    IssueReadError
  >;
  readonly postComment: (
    ref: RepositoryIssueRef,
    body: string,
  ) => Effect.Effect<InboxPosted, IssueReadError>;
  readonly postIssue: (
    scope: IssueRepositoryRef,
    input: {
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
    },
  ) => Effect.Effect<InboxPosted, IssueReadError>;
  readonly ensureLabels: (
    scope: IssueRepositoryRef,
    labels: ReadonlyArray<{ readonly name: string; readonly color: string }>,
  ) => Effect.Effect<void, IssueReadError>;
  readonly setLabels: (
    ref: RepositoryIssueRef,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
  ) => Effect.Effect<void, IssueReadError>;
}

export interface IssueGitHubExtensionContext {
  readonly safeRepository: (host: string, value: string) => string | null;
  readonly resolveScope: (
    operation: IssueReadError["operation"],
    input: IssueRepositoryRef,
  ) => Effect.Effect<IssueRepositoryScope, IssueReadError>;
}

const LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMENT_MAX_PAGES = 1_000;
/** Pages per listing per inbox poll; longer catch-ups skip ahead. */
const INBOX_MAX_PAGES = 50;
const COMMENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMENT_MAX_BODY_LENGTH = 60_000;
const MAX_PAGE = 1_000_000;
const GITHUB_HOST = "github.com";
const decodeLinkedIssue = Schema.decodeEffect(ThreadLinkedIssue);
const isIssueReadError = Schema.is(IssueReadError);
// ponytail: 10 pages (1,000 repos) caps the repository scan; raise it if an account outgrows it.
const REPOSITORY_MAX_PAGES = 10;

const IssueNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const RawActorSchema = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawLabelSchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{6}$/iu)))),
});
const RawMilestoneSchema = Schema.Struct({
  number: IssueNumber,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  due_on: Schema.optional(Schema.NullOr(IsoDateTime)),
  open_issues: NonNegativeInt,
  closed_issues: NonNegativeInt,
});
const RawIssueSchema = Schema.Struct({
  number: IssueNumber,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawActorSchema)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  milestone: Schema.optional(Schema.NullOr(RawMilestoneSchema)),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  closed_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  comments: NonNegativeInt,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
  sub_issues_summary: Schema.optional(
    Schema.NullOr(Schema.Struct({ total: NonNegativeInt, completed: NonNegativeInt })),
  ),
});

const RawRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  owner: Schema.Struct({ login: TrimmedNonEmptyString, type: Schema.String }),
  private: Schema.Boolean,
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  has_issues: Schema.Boolean,
  open_issues_count: NonNegativeInt,
  pushed_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  permissions: Schema.optional(Schema.Struct({ admin: Schema.Boolean })),
});
type RawRepository = Schema.Schema.Type<typeof RawRepositorySchema>;

/** A connection whose nodes GitHub may null out, e.g. when an organization's SSO hides one. */
const graphQlNodes = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.NullOr(node))) });
const GraphQlUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/iu));
const RawRepositoryIdentitySchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  full_name: TrimmedNonEmptyString,
});
const RawIssueIdentitySchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  node_id: TrimmedNonEmptyString,
  number: IssueNumber,
  title: Schema.String,
  html_url: GraphQlUrl,
  pull_request: Schema.optional(Schema.Unknown),
});
const RawGitHubCommentSchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.NullOr(Schema.String),
});
const RawGitHubCommentListSchema = Schema.Array(RawGitHubCommentSchema);
const WorkIssueNode = Schema.Struct({
  id: RawIssueIdentitySchema.fields.node_id,
  databaseId: RawIssueIdentitySchema.fields.id,
  number: IssueNumber,
  title: Schema.String,
  url: GraphQlUrl,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  repository: Schema.Struct({
    databaseId: RawRepositoryIdentitySchema.fields.id,
    nameWithOwner: RawRepositoryIdentitySchema.fields.full_name,
  }),
});
const WorkIssueConnection = Schema.Struct({
  totalCount: NonNegativeInt,
  nodes: Schema.Array(Schema.NullOr(WorkIssueNode)),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
});
const WorkIssueResponse = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            ...WorkIssueNode.fields,
            milestone: Schema.NullOr(Schema.Struct({ number: IssueNumber })),
            parent: Schema.NullOr(WorkIssueNode),
            subIssues: WorkIssueConnection,
            blockedBy: WorkIssueConnection,
          }),
        ),
      }),
    ),
  }),
});
const WORK_ISSUE_FIELDS =
  "id databaseId number title url state repository { databaseId nameWithOwner }";
const GraphQlPullRequestSchema = Schema.Struct({
  __typename: Schema.optional(Schema.Literal("PullRequest")),
  number: IssueNumber,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  url: GraphQlUrl,
  repository: Schema.Struct({ nameWithOwner: TrimmedNonEmptyString }),
});
const StatusConnection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({
    ...graphQlNodes(node).fields,
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  });
const StatusIssueNode = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  id: WorkIssueNode.fields.id,
  number: WorkIssueNode.fields.number,
  repository: GraphQlPullRequestSchema.fields.repository,
  state: WorkIssueNode.fields.state,
  stateReason: Schema.NullOr(Schema.String),
  blockedBy: StatusConnection(Schema.Struct({ state: WorkIssueNode.fields.state })),
  closedByPullRequestsReferences: StatusConnection(
    Schema.Struct({
      number: GraphQlPullRequestSchema.fields.number,
      repository: GraphQlPullRequestSchema.fields.repository,
      state: GraphQlPullRequestSchema.fields.state,
      updatedAt: IsoDateTime,
    }),
  ),
});
const StatusBatchResponse = Schema.Struct({
  data: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(Schema.Union([StatusIssueNode, Schema.Struct({ __typename: Schema.String })])),
    ),
  }),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
      }),
    ),
  ),
});
const STATUS_BATCH_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id number repository { nameWithOwner } state stateReason
      blockedBy(first: 100) { nodes { state } pageInfo { hasNextPage } }
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        nodes { number state updatedAt repository { nameWithOwner } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

type RawIssue = Schema.Schema.Type<typeof RawIssueSchema>;

type IssueOperation = IssueReadError["operation"];

class IssueResponseError extends IssueReadError.extend<IssueResponseError>("IssueResponseError")({
  status: Schema.Int,
}) {}
const isIssueResponseError = Schema.is(IssueResponseError);

interface ApiResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const issueListEndpoint = (
  scope: IssueRepositoryScope,
  state: RepositoryIssueListState,
  page: number,
  milestoneNumber?: number,
) =>
  `repos/${encodeRepositoryPath(scope.repository)}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}${milestoneNumber === undefined ? "" : `&milestone=${milestoneNumber}`}`;
const milestoneListEndpoint = (
  scope: IssueRepositoryScope,
  state: RepositoryIssueListState,
  page: number,
) =>
  `repos/${encodeRepositoryPath(scope.repository)}/milestones?state=${state}&per_page=100&page=${page}`;

function readError(
  operation: IssueOperation,
  code: IssueReadError["code"],
  message: string,
  retryAt?: number,
): IssueReadError {
  return new IssueReadError({
    code,
    operation,
    message,
    ...(retryAt === undefined ? {} : { retryAt }),
  });
}

function encodeRepositoryPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function issueUrl(host: string, repository: string, number: number): string {
  return `https://${host}/${encodeRepositoryPath(repository)}/issues/${number}`;
}

function milestoneUrl(host: string, repository: string, number: number): string {
  return `https://${host}/${encodeRepositoryPath(repository)}/milestone/${number}`;
}

export function ensureCommentMarker(body: string, marker: string): string {
  const markedBody = body.includes(marker) ? body : `${body.trimEnd()}\n\n${marker}`;
  if (markedBody.length <= COMMENT_MAX_BODY_LENGTH) return markedBody;
  const suffix = `\n\n[Comment truncated by T3 Code.]\n\n${marker}`;
  return `${markedBody.slice(0, COMMENT_MAX_BODY_LENGTH - suffix.length)}${suffix}`;
}

function normalizeAvatarUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    url.search = "";
    url.hash = "";
    return url.href.length <= 2_048 ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeActor(actor: Schema.Schema.Type<typeof RawActorSchema>): {
  readonly login: string;
  readonly avatarUrl: string | null;
} {
  return { login: actor.login, avatarUrl: normalizeAvatarUrl(actor.avatar_url) };
}

function normalizeMilestone(
  host: string,
  repository: string,
  milestone: Schema.Schema.Type<typeof RawMilestoneSchema>,
): IssueMilestone {
  return {
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
    dueAt: milestone.due_on ?? null,
    url: milestoneUrl(host, repository, milestone.number),
    openCount: milestone.open_issues,
    closedCount: milestone.closed_issues,
  };
}

function normalizeIssue(host: string, repository: string, issue: RawIssue): IssueSummaryType {
  return {
    number: issue.number,
    title: issue.title,
    url: issueUrl(host, repository, issue.number),
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    author: issue.user == null ? null : normalizeActor(issue.user),
    assignees: issue.assignees?.map(normalizeActor) ?? [],
    labels:
      issue.labels?.map((label) => ({
        name: label.name,
        color: label.color ?? null,
      })) ?? [],
    milestone:
      issue.milestone == null ? null : normalizeMilestone(host, repository, issue.milestone),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? null,
    commentCount: issue.comments,
    ...(issue.sub_issues_summary && issue.sub_issues_summary.total > 0
      ? {
          subIssues: {
            total: issue.sub_issues_summary.total,
            completed: issue.sub_issues_summary.completed,
          },
        }
      : {}),
  };
}

function presentNodes<A>(
  connection: { readonly nodes: ReadonlyArray<A | null> | null } | null,
): A[] {
  return connection?.nodes?.filter((node): node is A => node !== null) ?? [];
}

function nextPageFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  page: number,
): number | null | undefined {
  const link = headers["link"];
  if (link === undefined) return null;
  const next = /<([^>]+)>\s*;\s*rel=["']?next["']?/iu.exec(link)?.[1];
  if (next === undefined) return null;
  try {
    const nextPage = Number(new URL(next).searchParams.get("page"));
    return Number.isInteger(nextPage) && nextPage > page && nextPage <= MAX_PAGE
      ? nextPage
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a GitHub failure means for an issue read or write. */
function mapGitHubError(
  operation: IssueOperation,
  error: GitHubPullRequestApi.GitHubPullRequestApiError,
  write?: boolean,
): IssueReadError {
  const inaccessible = (status: 403 | 404) =>
    new IssueResponseError({
      operation,
      code: "inaccessible",
      message: !write
        ? "The GitHub repository is not accessible."
        : "GitHub issue write denied. Check repository access and Issues write permission.",
      status,
    });
  const failed = !write
    ? "GitHub could not complete the read."
    : "GitHub could not complete the issue write.";
  switch (error._tag) {
    case "GitHubCliMissingError":
      return readError(operation, "missing-tool", "No GitHub credential is available.");
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubCliFailedError":
    case "GitHubApiAuthenticationError":
      return readError(operation, "unauthenticated", "GitHub authentication is unavailable.");
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return readError(
        operation,
        "rate-limited",
        "GitHub API rate limit is active.",
        error.retryAt,
      );
    case "GitHubViewerLoginUnavailableError":
      return readError(
        operation,
        "verification-unavailable",
        "GitHub account verification is unavailable.",
      );
    case "GitHubApiNotFoundError":
      return inaccessible(404);
    case "GitHubApiResponseError":
      if (error.status === 403) return inaccessible(403);
      // A 2xx failure is a GraphQL answer: one GitHub cut at the size cap, or one carrying errors.
      if (error.status < 300) {
        return error.githubErrors === undefined
          ? readError(operation, "invalid-response", "GitHub returned a truncated response.")
          : readError(
              operation,
              "invalid-response",
              "GitHub did not return every requested field.",
            );
      }
      return new IssueResponseError({
        operation,
        code: "upstream",
        message: failed,
        status: error.status,
      });
    case "GitHubPullRequestReadError":
      return readError(operation, "invalid-response", "GitHub returned an invalid response.");
    case "GitHubRepositorySelectorError":
      return readError(
        operation,
        "scope-unavailable",
        "The registered repository cannot be addressed.",
      );
    default:
      return readError(operation, "upstream", failed);
  }
}

/**
 * Repositories the viewer controls: ones they own, plus organization repositories they
 * administer. Repositories with issues disabled are left out.
 */
function selectIssueRepositories(
  host: string,
  viewerLogin: string,
  repositories: ReadonlyArray<RawRepository>,
  safeRepository: IssueGitHubExtensionContext["safeRepository"],
): IssueRepositorySummary[] {
  const viewer = viewerLogin.toLowerCase();
  const seen = new Set<string>();
  const selected: IssueRepositorySummary[] = [];
  for (const repository of repositories) {
    const ownedByViewer = repository.owner.login.toLowerCase() === viewer;
    const administeredOrganization =
      repository.owner.type === "Organization" && repository.permissions?.admin === true;
    if (!repository.has_issues) continue;
    if (!ownedByViewer && !administeredOrganization) continue;
    const name = safeRepository(host, repository.full_name);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    selected.push({
      host,
      repository: name,
      owner: repository.owner.login,
      ownerIsOrganization: repository.owner.type === "Organization",
      isPrivate: repository.private,
      isArchived: repository.archived,
      isFork: repository.fork,
      openIssuesAndPullRequests: repository.open_issues_count,
      pushedAt: repository.pushed_at ?? null,
    });
  }
  return selected;
}

const decodeRawIssueList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssueSchema)));
const decodeRawMilestoneList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawMilestoneSchema)),
);
const decodeRawRepositoryList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawRepositorySchema)),
);

const Author = Schema.NullOr(
  Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }),
);
const Labels = Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))));
const InboxIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.optional(Schema.Literals(["open", "closed"])),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Author),
  labels: Labels,
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Number }))),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});
const InboxComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Author),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.String,
  issue_url: Schema.String,
});
const InboxEvent = Schema.Struct({
  id: Schema.Number,
  event: Schema.String,
  created_at: Schema.String,
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Number,
        pull_request: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
});
const InboxPosted = Schema.Struct({
  id: Schema.Number,
  number: Schema.optional(Schema.Number),
  html_url: Schema.String,
});
const InboxListedComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});
interface RepositoryRequest {
  readonly host: string;
  readonly repository: string;
  readonly path: string;
  readonly method?: "POST" | "DELETE";
  readonly body?: unknown;
  readonly ifNoneMatch?: string;
}

export const make = Effect.fn("IssueGitHubHost.make")(function* (
  context: IssueGitHubExtensionContext,
) {
  const api = yield* GitHubApi.GitHubApi;
  const githubPullRequests = yield* GitHubPullRequestApi.GitHubPullRequestApi;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const { safeRepository, resolveScope } = context;
  const executeApi = Effect.fn("IssueService.executeApi")(function* (input: {
    readonly operation: IssueOperation;
    readonly scope: IssueRepositoryScope;
    readonly endpoint: string;
    readonly maxOutputBytes: number;
    readonly ifNoneMatch?: string | undefined;
    readonly graphql?: {
      readonly query: string;
      readonly variables: Readonly<Record<string, string | number>>;
      /** Read instead when GitHub refuses part of `query`. */
      readonly fallbackQuery?: string;
    };
    readonly requestMethod?: "POST" | "PATCH" | "DELETE";
    readonly requestBody?: Readonly<Record<string, string | number | null>>;
  }): Effect.fn.Return<ApiResponse, IssueReadError> {
    const { host } = input.scope;
    const operation = `issues.${input.operation}`;
    const graphql = input.graphql;
    const query = (document: string, variables: Readonly<Record<string, string | number>>) =>
      api
        .graphql({
          host,
          operation,
          query: document,
          variables,
          maxResponseBytes: input.maxOutputBytes,
        })
        .pipe(Effect.map((body): ApiResponse | null => ({ status: 200, body, headers: {} })));
    const send: Effect.Effect<ApiResponse | null, GitHubApi.GitHubApiError> =
      graphql === undefined
        ? api
            .rest({
              host,
              operation,
              path: input.endpoint,
              ...(input.requestMethod === undefined ? {} : { method: input.requestMethod }),
              ...(input.requestBody === undefined ? {} : { body: input.requestBody }),
              ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
              maxResponseBytes: input.maxOutputBytes,
            })
            .pipe(
              Effect.map((response): ApiResponse | null => (response.truncated ? null : response)),
            )
        : query(graphql.query, graphql.variables).pipe(
            Effect.catchIf(
              (error) =>
                graphql.fallbackQuery !== undefined &&
                error._tag === "GitHubApiResponseError" &&
                error.status < 300 &&
                error.githubErrors !== undefined,
              () => query(graphql.fallbackQuery!, graphql.variables),
            ),
          );
    const response = yield* send.pipe(
      Effect.mapError((error) =>
        mapGitHubError(input.operation, error, input.requestMethod !== undefined),
      ),
    );
    if (response === null) {
      return yield* readError(
        input.operation,
        "invalid-response",
        "GitHub returned a truncated response.",
      );
    }
    return response;
  });

  const decodeApiResponse = <A, I>(
    operation: IssueOperation,
    schema: Schema.Codec<A, I>,
    response: ApiResponse,
    message: string,
  ) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(response.body).pipe(
      Effect.mapError(() => readError(operation, "invalid-response", message)),
    );

  const findMarkedComment = Effect.fn("IssueService.findMarkedComment")(function* (
    scope: IssueRepositoryScope,
    issueNumber: number,
    marker: string,
  ): Effect.fn.Return<Schema.Schema.Type<typeof RawGitHubCommentSchema> | null, IssueReadError> {
    let page: number | null = 1;
    let pagesRead = 0;
    while (page !== null) {
      if (pagesRead >= COMMENT_MAX_PAGES) {
        return yield* readError(
          "detail",
          "invalid-response",
          "GitHub returned more issue comments than can be reconciled safely.",
        );
      }
      const response = yield* executeApi({
        operation: "detail",
        scope,
        endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        maxOutputBytes: COMMENT_MAX_OUTPUT_BYTES,
      });
      const comments = yield* decodeApiResponse(
        "detail",
        RawGitHubCommentListSchema,
        response,
        "GitHub returned an invalid issue comment list.",
      );
      const matching = comments.find((comment) => comment.body?.includes(marker) === true);
      if (matching !== undefined) return matching;
      const nextPage = nextPageFromHeaders(response.headers, page);
      if (nextPage === undefined) {
        return yield* readError(
          "detail",
          "invalid-response",
          "GitHub returned invalid issue comment pagination metadata.",
        );
      }
      page = nextPage;
      pagesRead += 1;
    }
    return null;
  });

  const statuses: IssueGitHubExtension["statuses"] = Effect.fn("IssueService.statuses")(
    function* (host, nodeIds) {
      const statuses: Array<IssueStatusBatchResult[number] & RepositoryIssueRef> = [];
      const ids = [...nodeIds];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const body = yield* api
          .graphql({
            host,
            operation: "issues.statusBatch",
            query: STATUS_BATCH_QUERY,
            variables: { ids: batch },
            maxResponseBytes: LIST_MAX_OUTPUT_BYTES,
            acceptPartialData: true,
          })
          .pipe(Effect.mapError((error) => mapGitHubError("detail", error)));
        const response = yield* decodeApiResponse(
          "detail",
          StatusBatchResponse,
          { status: 200, body, headers: {} },
          "GitHub returned invalid issue status data.",
        );
        for (const [index, node] of response.data.nodes.entries()) {
          const failed = response.errors?.some(
            (error) =>
              error.path === undefined ||
              (error.path[0] === "nodes" && (error.path.length < 2 || error.path[1] === index)),
          );
          // Incomplete relationships cannot safely claim that an issue is unblocked or unreviewed.
          if (
            node === null ||
            !("id" in node) ||
            failed ||
            !batch.includes(node.id) ||
            node.blockedBy.pageInfo.hasNextPage ||
            node.closedByPullRequestsReferences.pageInfo.hasNextPage
          )
            continue;
          statuses.push({
            host,
            repository: node.repository.nameWithOwner,
            number: node.number,
            nodeId: node.id,
            state: node.state === "OPEN" ? "open" : "closed",
            stateReason: node.stateReason?.toLowerCase() ?? null,
            blockedBy: presentNodes(node.blockedBy).map((blocker) => ({
              state: blocker.state === "OPEN" ? "open" : "closed",
            })),
            pullRequests: presentNodes(node.closedByPullRequestsReferences).map((pr) => ({
              host,
              repository: pr.repository.nameWithOwner,
              number: pr.number,
              state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
              updatedAt: pr.updatedAt,
            })),
          });
        }
      }
      return statuses;
    },
  );

  const workRead: IssueGitHubExtension["workRead"] = Effect.fn("IssueService.workRead")(
    function* (input) {
      const scope = yield* resolveScope("detail", input);
      return yield* githubPullRequests
        .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, () =>
          Effect.gen(function* () {
            const [owner, name] = scope.repository.split("/");
            const linked = (node: typeof WorkIssueNode.Type): ThreadLinkedIssueType => ({
              host: scope.host,
              repository: node.repository.nameWithOwner,
              repositoryId: String(node.repository.databaseId),
              id: String(node.databaseId),
              nodeId: node.id,
              number: node.number,
              title: node.title,
              url: node.url,
            });
            const children = new Map<string, ThreadLinkedIssueType>();
            const blockers = new Map<string, IssueWorkRead["blockedBy"][number]>();
            let subCursor: string | undefined;
            let blockerCursor: string | undefined;
            let result: IssueWorkRead | undefined;
            // Bounded reads fail closed if GitHub changes connections during pagination.
            for (let page = 0; page < 10; page++) {
              const response = yield* executeApi({
                operation: "detail",
                scope,
                endpoint: "graphql",
                maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
                graphql: {
                  query: `query($owner: String!, $name: String!, $number: Int!, $sub: String, $block: String) {
              repository(owner: $owner, name: $name) { issue(number: $number) {
                ${WORK_ISSUE_FIELDS} milestone { number } parent { ${WORK_ISSUE_FIELDS} }
                subIssues(first: 100, after: $sub) { totalCount nodes { ${WORK_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
                blockedBy(first: 100, after: $block) { totalCount nodes { ${WORK_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
              } }
            }`,
                  variables: {
                    owner: owner!,
                    name: name!,
                    number: input.number,
                    ...(subCursor === undefined ? {} : { sub: subCursor }),
                    ...(blockerCursor === undefined ? {} : { block: blockerCursor }),
                  },
                },
              });
              const decoded = yield* decodeApiResponse(
                "detail",
                WorkIssueResponse,
                response,
                "Issue hierarchy or dependencies could not be read.",
              );
              const node = decoded.data.repository?.issue;
              if ((decoded.errors?.length ?? 0) > 0)
                return yield* readError(
                  "detail",
                  "invalid-response",
                  "Issue hierarchy or dependencies could not be read completely.",
                );
              if (node == null)
                return yield* readError(
                  "detail",
                  "inaccessible",
                  "Issue hierarchy or dependencies could not be read completely.",
                );
              if (safeRepository(scope.host, node.repository.nameWithOwner) !== scope.repository)
                return yield* readError(
                  "detail",
                  "invalid-response",
                  "GitHub returned another repository.",
                );
              if (node.number !== input.number)
                return yield* readError(
                  "detail",
                  "invalid-response",
                  "GitHub returned another issue.",
                );
              for (const child of node.subIssues.nodes)
                if (child !== null) children.set(child.id, linked(child));
              for (const blocker of node.blockedBy.nodes)
                if (blocker !== null)
                  blockers.set(blocker.id, {
                    issue: linked(blocker),
                    state: blocker.state === "OPEN" ? "open" : "closed",
                  });
              result = {
                issue: linked(node),
                state: node.state === "OPEN" ? "open" : "closed",
                milestoneNumber: node.milestone?.number ?? null,
                parent: node.parent === null ? null : linked(node.parent),
                parentComplete: true,
                subIssues: [...children.values()],
                blockedBy: [...blockers.values()],
                subIssuesComplete:
                  !node.subIssues.pageInfo.hasNextPage &&
                  children.size === node.subIssues.totalCount,
                blockersComplete:
                  !node.blockedBy.pageInfo.hasNextPage &&
                  blockers.size === node.blockedBy.totalCount,
              };
              if (result.subIssuesComplete && result.blockersComplete) break;
              if (!node.subIssues.pageInfo.hasNextPage && !node.blockedBy.pageInfo.hasNextPage)
                break;
              const nextSub = node.subIssues.pageInfo.hasNextPage
                ? node.subIssues.pageInfo.endCursor
                : subCursor;
              const nextBlock = node.blockedBy.pageInfo.hasNextPage
                ? node.blockedBy.pageInfo.endCursor
                : blockerCursor;
              if (
                (node.subIssues.pageInfo.hasNextPage &&
                  (nextSub == null || nextSub === subCursor)) ||
                (node.blockedBy.pageInfo.hasNextPage &&
                  (nextBlock == null || nextBlock === blockerCursor))
              )
                break;
              subCursor = nextSub ?? undefined;
              blockerCursor = nextBlock ?? undefined;
            }
            return result!;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isIssueReadError(error) ? error : mapGitHubError("detail", error),
          ),
        );
    },
  );

  const readRepositoryIdentity = Effect.fn("IssueService.readRepositoryIdentity")(function* (
    scope: IssueRepositoryScope,
  ) {
    const response = yield* executeApi({
      operation: "detail",
      scope,
      endpoint: `repos/${encodeRepositoryPath(scope.repository)}`,
      maxOutputBytes: 256 * 1024,
    });
    const repository = yield* decodeApiResponse(
      "detail",
      RawRepositoryIdentitySchema,
      response,
      "GitHub returned an invalid repository identity.",
    );
    if (safeRepository(scope.host, repository.full_name) !== scope.repository)
      return yield* readError("detail", "invalid-response", "GitHub returned another repository.");
    return {
      host: scope.host,
      repository: repository.full_name,
      repositoryId: String(repository.id),
    };
  });
  const repositoryIdentity: IssueGitHubExtension["repositoryIdentity"] = Effect.fn(
    "IssueService.repositoryIdentity",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input);
    return yield* verified(scope, readRepositoryIdentity(scope));
  });

  const resolveLinkedIssue: IssueGitHubExtension["resolveLinkedIssue"] = Effect.fn(
    "IssueService.resolveLinkedIssue",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input);
    return yield* githubPullRequests
      .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, () =>
        Effect.gen(function* () {
          const repository = yield* readRepositoryIdentity(scope);
          const issueResponse = yield* executeApi({
            operation: "detail",
            scope,
            endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.number}`,
            maxOutputBytes: 256 * 1024,
          });
          const issue = yield* decodeApiResponse(
            "detail",
            RawIssueIdentitySchema,
            issueResponse,
            "GitHub returned an invalid issue identity.",
          );
          if (Object.hasOwn(issue, "pull_request")) {
            return yield* readError(
              "detail",
              "unsupported",
              "Pull requests are not GitHub issues.",
            );
          }
          if (issue.number !== input.number) {
            return yield* readError("detail", "invalid-response", "GitHub returned another issue.");
          }
          return yield* decodeLinkedIssue({
            ...repository,
            id: String(issue.id),
            nodeId: issue.node_id,
            number: issue.number,
            url: issue.html_url,
            title: issue.title,
          }).pipe(
            Effect.mapError(() =>
              readError("detail", "invalid-response", "GitHub returned an invalid issue identity."),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("detail", error),
        ),
      );
  });

  const findManagedComment: IssueGitHubExtension["findManagedComment"] = Effect.fn(
    "IssueService.findManagedComment",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input.issue);
    return yield* verified(
      scope,
      findMarkedComment(scope, input.issue.number, input.marker).pipe(
        Effect.map((comment) =>
          comment === null ? null : { id: String(comment.id), body: comment.body ?? null },
        ),
      ),
    );
  });

  const updateManagedComment: IssueGitHubExtension["updateManagedComment"] = Effect.fn(
    "IssueService.updateManagedComment",
  )(function* (input) {
    if (!/^\d+$/u.test(input.commentId))
      return yield* readError("detail", "invalid-response", "The stored comment ID is invalid.");
    const scope = yield* resolveScope("detail", input.issue);
    yield* verified(
      scope,
      executeApi({
        operation: "detail",
        scope,
        endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/comments/${input.commentId}`,
        maxOutputBytes: 256 * 1024,
        requestMethod: "PATCH",
        requestBody: { body: input.body },
      }),
    );
  });

  const listIssuePage = Effect.fn("IssueService.listIssuePage")(
    function* (
      scope: IssueRepositoryScope,
      state: RepositoryIssueListState,
      page: number,
      milestoneNumber?: number,
      etag?: string,
    ) {
      const endpoint = issueListEndpoint(scope, state, page, milestoneNumber);
      const response = yield* executeApi({
        operation: "list",
        scope,
        endpoint,
        ifNoneMatch: etag,
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      });
      const nextPage =
        response.status === 304 && response.headers["link"] === undefined
          ? undefined
          : nextPageFromHeaders(response.headers, page);
      if (
        nextPage === undefined &&
        !(response.status === 304 && response.headers["link"] === undefined)
      ) {
        return yield* readError(
          "list",
          "invalid-response",
          "GitHub returned invalid pagination metadata.",
        );
      }
      if (response.status === 304) {
        return { notModified: true as const, nextPage, etag: response.headers["etag"] };
      }
      const raw = yield* decodeRawIssueList(response.body).pipe(
        Effect.mapError(() =>
          readError("list", "invalid-response", "GitHub returned an invalid issue list."),
        ),
      );
      const result = {
        items: raw
          .filter((issue) => !Object.hasOwn(issue, "pull_request"))
          .map((issue) => normalizeIssue(scope.host, scope.repository, issue)),
        nextPage: nextPage ?? null,
      };
      const pageResult = {
        ...result,
        etag: response.headers["etag"],
      };
      return pageResult;
    },
    (effect, scope, _state, _page, milestoneNumber) =>
      milestoneNumber === undefined
        ? effect
        : effect.pipe(
            // GitHub also uses 422 for its spam guard; only a milestone 404 proves it is missing.
            Effect.catchIf(
              (error) => isIssueResponseError(error) && error.status === 422,
              (listError) =>
                executeApi({
                  operation: "list",
                  scope,
                  endpoint: `repos/${encodeRepositoryPath(scope.repository)}/milestones/${milestoneNumber}`,
                  maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
                }).pipe(
                  Effect.matchEffect({
                    onSuccess: () => Effect.fail(listError),
                    onFailure: (lookupError) =>
                      isIssueResponseError(lookupError) && lookupError.status === 404
                        ? Effect.succeed({ items: [], nextPage: null, missing: true as const })
                        : Effect.fail(listError),
                  }),
                ),
            ),
          ),
  );

  const listMilestonePage = Effect.fn("IssueService.listMilestonePage")(function* (
    scope: IssueRepositoryScope,
    state: RepositoryIssueListState,
    page: number,
    etag?: string,
  ) {
    const endpoint = milestoneListEndpoint(scope, state, page);
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint,
      ifNoneMatch: etag,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const nextPage =
      response.status === 304 && response.headers["link"] === undefined
        ? undefined
        : nextPageFromHeaders(response.headers, page);
    if (
      nextPage === undefined &&
      !(response.status === 304 && response.headers["link"] === undefined)
    ) {
      return yield* readError(
        "list",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    if (response.status === 304) {
      return { notModified: true as const, nextPage, etag: response.headers["etag"] };
    }
    const raw = yield* decodeRawMilestoneList(response.body).pipe(
      Effect.mapError(() =>
        readError("list", "invalid-response", "GitHub returned an invalid milestone list."),
      ),
    );
    const result = {
      items: raw.map((milestone) => normalizeMilestone(scope.host, scope.repository, milestone)),
      nextPage: nextPage ?? null,
    };
    const pageResult = { ...result, etag: response.headers["etag"] };
    return pageResult;
  });

  const listRepositoryPage = Effect.fn("IssueService.listRepositoryPage")(function* (
    scope: IssueRepositoryScope,
    page: number,
  ): Effect.fn.Return<PageResult<RawRepository>, IssueReadError> {
    const response = yield* executeApi({
      operation: "repositories",
      scope,
      endpoint: `user/repos?affiliation=owner,organization_member&sort=pushed&per_page=100&page=${page}`,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const items = yield* decodeRawRepositoryList(response.body).pipe(
      Effect.mapError(() =>
        readError(
          "repositories",
          "invalid-response",
          "GitHub returned an invalid repository list.",
        ),
      ),
    );
    const nextPage = nextPageFromHeaders(response.headers, page);
    if (nextPage === undefined) {
      return yield* readError(
        "repositories",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    return { items, nextPage };
  });

  const repositories: IssueGitHubExtension["repositories"] = Effect.fn("IssueService.repositories")(
    function* () {
      const scope: IssueRepositoryScope = {
        cwd: homeDirectory,
        host: GITHUB_HOST,
        repository: "",
      };
      return yield* githubPullRequests
        .withVerifiedCredential(
          { cwd: scope.cwd, host: scope.host },
          (
            identity,
          ): Effect.Effect<
            IssueRepositoriesResultType,
            IssueReadError | GitHubPullRequestApi.GitHubPullRequestApiError
          > =>
            Effect.gen(function* () {
              const raw: RawRepository[] = [];
              let page: number | null = 1;
              let pagesRead = 0;
              while (page !== null && pagesRead < REPOSITORY_MAX_PAGES) {
                const result: PageResult<RawRepository> = yield* listRepositoryPage(scope, page);
                raw.push(...result.items);
                page = result.nextPage;
                pagesRead += 1;
              }
              return {
                viewer: { accountId: identity.accountId, login: identity.viewer },
                repositories: selectIssueRepositories(
                  scope.host,
                  identity.viewer,
                  raw,
                  safeRepository,
                ),
                complete: page === null,
                fetchedAt: DateTime.formatIso(yield* DateTime.now),
              } satisfies IssueRepositoriesResultType;
            }),
        )
        .pipe(
          Effect.mapError((error) =>
            isIssueReadError(error) ? error : mapGitHubError("repositories", error),
          ),
        );
    },
  );

  const ChangeIssue = Schema.Struct({
    ...RawIssueIdentitySchema.fields,
    body: Schema.NullOr(Schema.String),
    state: Schema.Literals(["open", "closed"]),
    milestone: Schema.NullOr(Schema.Struct({ number: IssueNumber })),
  });
  const baseline = (
    scope: IssueRepositoryScope,
    repositoryId: string,
    raw: typeof ChangeIssue.Type,
  ): IssueChangeBaseline => ({
    issue: {
      host: scope.host,
      repository: scope.repository,
      repositoryId,
      id: String(raw.id),
      nodeId: raw.node_id,
      number: raw.number,
      title: raw.title,
      url: raw.html_url,
    },
    body: raw.body ?? "",
    state: raw.state,
    milestoneNumber: raw.milestone?.number ?? null,
  });
  const verified = <A, R>(
    scope: IssueRepositoryScope,
    effect: Effect.Effect<A, IssueReadError, R>,
  ) =>
    githubPullRequests
      .withVerifiedCredential(scope, () => effect)
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("detail", error),
        ),
      );
  const withRepositoryCredential: IssueGitHubExtension["withRepositoryCredential"] = Effect.fn(
    "IssueService.withRepositoryCredential",
  )(function* (input, use) {
    const scope = yield* resolveScope("detail", input);
    return yield* verified(scope, use.pipe(Effect.result)).pipe(Effect.flatMap(Effect.fromResult));
  });
  const readChangeState: IssueGitHubExtension["readChangeState"] = Effect.fn(
    "IssueService.readChangeState",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input);
    return yield* verified(
      scope,
      Effect.gen(function* () {
        const repository = yield* readRepositoryIdentity(scope);
        const response = yield* executeApi({
          operation: "detail",
          scope,
          endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.number}`,
          maxOutputBytes: 256 * 1024,
        });
        const raw = yield* decodeApiResponse(
          "detail",
          ChangeIssue,
          response,
          "GitHub returned an invalid issue.",
        );
        if (Object.hasOwn(raw, "pull_request") || raw.number !== input.number)
          return yield* readError(
            "detail",
            "unsupported",
            "The target is not the requested GitHub issue.",
          );
        return baseline(scope, repository.repositoryId, raw);
      }),
    );
  });
  const findCreatedIssue: IssueGitHubExtension["findCreatedIssue"] = Effect.fn(
    "IssueService.findCreatedIssue",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input);
    return yield* verified(
      scope,
      Effect.gen(function* () {
        const repository = yield* readRepositoryIdentity(scope);
        // Never infer ownership from the author login: only the marker proves T3 made it.
        for (let page = 1; page <= COMMENT_MAX_PAGES; page++) {
          const response = yield* executeApi({
            operation: "detail",
            scope,
            endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues?state=all&per_page=100&page=${page}`,
            maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
          });
          const rows = yield* decodeApiResponse(
            "detail",
            Schema.Array(ChangeIssue),
            response,
            "GitHub returned an incomplete issue recovery page.",
          );
          const existing = rows.find(
            (row) => !Object.hasOwn(row, "pull_request") && row.body?.includes(input.marker),
          );
          if (existing !== undefined) return baseline(scope, repository.repositoryId, existing);
          if (rows.length < 100) return null;
        }
        return yield* readError(
          "detail",
          "invalid-response",
          "Issue recovery pagination is incomplete; creation was not retried.",
        );
      }),
    );
  });
  const patchIssue = Effect.fn("IssueService.patchIssue")(function* (
    input: import("@t3tools/contracts").RepositoryIssueRef,
    payload: Readonly<Record<string, string | number | null>>,
  ) {
    const scope = yield* resolveScope("detail", input);
    yield* verified(
      scope,
      executeApi({
        operation: "detail",
        scope,
        endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.number}`,
        requestMethod: "PATCH",
        requestBody: payload,
        maxOutputBytes: 256 * 1024,
      }),
    );
  });
  const setParent: IssueGitHubExtension["setParent"] = Effect.fn("IssueService.setParent")(
    function* (input) {
      const scope = yield* resolveScope("detail", input.parent);
      const childId = Number(input.child.id);
      if (
        input.child.host !== input.parent.host ||
        input.child.repositoryId !== input.parent.repositoryId ||
        !Number.isSafeInteger(childId) ||
        childId < 1
      )
        return yield* readError(
          "detail",
          "unsupported",
          "Sub-issues must belong to this repository and have a valid GitHub ID.",
        );
      yield* verified(
        scope,
        executeApi({
          operation: "detail",
          scope,
          endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.parent.number}/${input.action === "add" ? "sub_issues" : "sub_issue"}`,
          requestMethod: input.action === "add" ? "POST" : "DELETE",
          requestBody: { sub_issue_id: childId },
          maxOutputBytes: 256 * 1024,
        }),
      );
    },
  );
  const setBlockedBy: IssueGitHubExtension["setBlockedBy"] = Effect.fn("IssueService.setBlockedBy")(
    function* ({ issue, blocker, action }) {
      if (
        issue.host !== blocker.host ||
        issue.repositoryId !== blocker.repositoryId ||
        issue.id === blocker.id
      )
        return yield* readError(
          "detail",
          "unsupported",
          "Blockers must be different issues in this repository.",
        );
      const scope = yield* resolveScope("detail", issue);
      const mutation = action === "add" ? "addBlockedBy" : "removeBlockedBy";
      yield* verified(
        scope,
        executeApi({
          operation: "detail",
          scope,
          endpoint: "graphql",
          maxOutputBytes: 256 * 1024,
          graphql: {
            query: `mutation($issueId: ID!, $blockingIssueId: ID!) { ${mutation}(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { clientMutationId } }`,
            variables: { issueId: issue.nodeId, blockingIssueId: blocker.nodeId },
          },
        }),
      );
    },
  );
  const inboxRequest = Effect.fn("IssueService.inboxRequest")(function* (input: RepositoryRequest) {
    const scope = yield* resolveScope("detail", input);
    const response = yield* verified(
      scope,
      api
        .rest({
          host: scope.host,
          operation: "issues.inbox",
          path: `repos/${encodeRepositoryPath(scope.repository)}/${input.path}`,
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
          maxResponseBytes: LIST_MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.mapError((error) => mapGitHubError("detail", error, input.method !== undefined)),
        ),
    );
    if (response.truncated)
      return yield* readError(
        "detail",
        "invalid-response",
        "GitHub returned a truncated response.",
      );
    const nextPage = nextPageFromHeaders(response.headers, 0);
    if (nextPage === undefined)
      return yield* readError(
        "detail",
        "invalid-response",
        "GitHub returned an invalid next page.",
      );
    return {
      status: response.status,
      body: response.body,
      etag: response.headers["etag"] ?? null,
      nextPage,
    };
  });
  const decodeInbox = <S extends Schema.Top>(
    schema: S,
    body: string,
    message = "GitHub returned an invalid inbox response.",
  ) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(() => readError("detail", "invalid-response", message)),
    );
  const readActivityPages = Effect.fn("IssueService.readActivityPages")(function* <
    S extends Schema.Top,
  >(
    scope: IssueRepositoryRef,
    path: string,
    schema: S,
    etag: string | null,
    enough: (items: ReadonlyArray<S["Type"]>) => boolean = () => false,
    maxPages = INBOX_MAX_PAGES,
  ) {
    const first = yield* inboxRequest({
      ...scope,
      path: `${path}&page=1`,
      ...(etag === null ? {} : { ifNoneMatch: etag }),
    });
    if (first.status === 304)
      return { items: [] as ReadonlyArray<S["Type"]>, etag, complete: true };
    const items = [...(yield* decodeInbox(Schema.Array(schema), first.body))];
    let next = first.nextPage;
    for (let pages = 1; next !== null && !enough(items); pages++) {
      if (pages >= maxPages) return { items, etag: first.etag, complete: false };
      const page = yield* inboxRequest({ ...scope, path: `${path}&page=${next}` });
      items.push(...(yield* decodeInbox(Schema.Array(schema), page.body)));
      next = page.nextPage;
    }
    return { items, etag: first.etag, complete: true };
  });
  const activitySince: IssueGitHubExtension["activitySince"] = Effect.fn(
    "IssueService.activitySince",
  )(function* (scope, cursors) {
    if (cursors.initial) {
      const response = yield* inboxRequest({
        ...scope,
        path: "issues/events?per_page=100&page=1",
      });
      const events = yield* decodeInbox(Schema.Array(InboxEvent), response.body);
      return {
        issues: { items: [], etag: null, complete: true },
        comments: { items: [], etag: null, complete: true },
        stateChanges: { items: [], etag: response.etag, complete: true },
        eventsAfter: Math.max(0, ...events.map((event) => event.id)),
      };
    }
    const issues = yield* readActivityPages(
      scope,
      `issues?state=all&sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(cursors.issuesSince)}`,
      InboxIssue,
      cursors.issuesEtag,
    );
    const comments = yield* readActivityPages(
      scope,
      `issues/comments?sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(cursors.commentsSince)}`,
      InboxComment,
      cursors.commentsEtag,
    );
    const stateChanges = yield* readActivityPages(
      scope,
      "issues/events?per_page=100",
      InboxEvent,
      cursors.eventsEtag,
      (events) => events.some((event) => event.id <= cursors.eventsAfter),
    );
    return {
      issues,
      comments,
      stateChanges,
      eventsAfter: Math.max(cursors.eventsAfter, ...stateChanges.items.map((event) => event.id)),
    };
  });
  const listComments: IssueGitHubExtension["listComments"] = Effect.fn("IssueService.listComments")(
    function* (ref, options) {
      const result = yield* readActivityPages(
        ref,
        `issues/${ref.number}/comments?per_page=100`,
        InboxListedComment,
        null,
        options?.until,
        options?.maxPages ?? Infinity,
      );
      return { comments: result.items, complete: result.complete };
    },
  );
  const postComment: IssueGitHubExtension["postComment"] = Effect.fn("IssueService.postComment")(
    function* (ref, body) {
      const response = yield* inboxRequest({
        ...ref,
        path: `issues/${ref.number}/comments`,
        method: "POST",
        body: { body },
      });
      return yield* decodeInbox(
        InboxPosted,
        response.body,
        "GitHub returned an invalid created issue or comment.",
      );
    },
  );
  const postIssue: IssueGitHubExtension["postIssue"] = Effect.fn("IssueService.postIssue")(
    function* (scope, input) {
      const response = yield* inboxRequest({
        ...scope,
        path: "issues",
        method: "POST",
        body: {
          title: input.title,
          body: input.body,
          ...(input.labels.length > 0 ? { labels: input.labels } : {}),
        },
      });
      return yield* decodeInbox(
        InboxPosted,
        response.body,
        "GitHub returned an invalid created issue or comment.",
      );
    },
  );
  const ensureLabels: IssueGitHubExtension["ensureLabels"] = Effect.fn("IssueService.ensureLabels")(
    function* (scope, labels) {
      const response = yield* inboxRequest({ ...scope, path: "labels?per_page=100" });
      const existing = new Set(
        (yield* decodeInbox(
          Schema.Array(Schema.Struct({ name: Schema.String })),
          response.body,
        )).map((label) => label.name.toLowerCase()),
      );
      for (const label of labels)
        if (!existing.has(label.name.toLowerCase()))
          yield* inboxRequest({ ...scope, path: "labels", method: "POST", body: label }).pipe(
            Effect.catch(() => Effect.void),
          );
    },
  );
  const setLabels: IssueGitHubExtension["setLabels"] = Effect.fn("IssueService.setLabels")(
    function* (ref, add, remove) {
      if (add.length > 0)
        yield* inboxRequest({
          ...ref,
          path: `issues/${ref.number}/labels`,
          method: "POST",
          body: { labels: add },
        });
      if (remove.length === 0) return;
      const response = yield* inboxRequest({
        ...ref,
        path: `issues/${ref.number}/labels?per_page=100`,
      });
      const labels = yield* decodeInbox(
        Schema.Array(Schema.Struct({ name: Schema.String })),
        response.body,
      );
      for (const name of remove)
        if (labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))
          yield* inboxRequest({
            ...ref,
            path: `issues/${ref.number}/labels/${encodeURIComponent(name)}`,
            method: "DELETE",
          });
    },
  );
  return {
    capabilities: ISSUE_HOSTS.github!.capabilities,
    pullRequest: (input) =>
      githubPullRequests
        .getPullRequestDetail(input)
        .pipe(Effect.mapError((error) => mapGitHubError("detail", error))),
    activitySince,
    listComments,
    postComment,
    postIssue,
    ensureLabels,
    setLabels,
    withRepositoryCredential,
    readChangeState,
    findCreatedIssue,
    setMilestone: Effect.fn("IssueService.setMilestone")((input) =>
      patchIssue(input, { milestone: input.milestoneNumber }),
    ),
    setParent,
    setBlockedBy,
    repositories,
    listIssuePage,
    listMilestonePage,
    listMetadata: (scope, numbers, projectAccess) =>
      readIssueListMetadata(scope, numbers, projectAccess).pipe(
        Effect.provideService(GitHubApi.GitHubApi, api),
      ),
    withIdentity: (scope, operation, read) =>
      githubPullRequests
        .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, read)
        .pipe(
          Effect.mapError((error) =>
            isIssueReadError(error) ? error : mapGitHubError(operation, error),
          ),
        ),
    workRead,
    statuses,
    repositoryIdentity,
    resolveLinkedIssue,
    findManagedComment,
    updateManagedComment,
  } satisfies IssueGitHubExtension;
});
