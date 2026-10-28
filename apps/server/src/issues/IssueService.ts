import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  LIVE_ISSUE_REFRESH_MS,
  IssueMilestone,
  IssueListResult,
  IssueReadError,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type IssueDetailInput as IssueDetailInputType,
  type IssueDetailResult as IssueDetailResultType,
  type IssueLinkedPullRequest,
  type IssueStatusBatchInput,
  type IssueStatusBatchResult,
  type IssueListInput as IssueListInputType,
  type IssueListResult as IssueListResultType,
  type IssueListState,
  type IssueRepositoriesResult as IssueRepositoriesResultType,
  type IssueRepositorySummary,
  type IssueSummary as IssueSummaryType,
  ThreadLinkedIssue,
  type IssueWorkRead,
  type IssueChangeBaseline,
  type IssueRepositoryRef,
  type IssueRef,
  type ThreadLinkedIssue as ThreadLinkedIssueType,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitHubApi from "./IssueGitHubApi.ts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import { readIssueListMetadata } from "./IssueProjects.ts";
import { IssueListPageCache } from "./IssueListPageCache.ts";

const LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// A detail read carries up to DETAIL_COMMENT_LIMIT comment bodies of up to 64 KiB each.
const DETAIL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DETAIL_COMMENT_LIMIT = 100;
const COMMENT_MAX_PAGES = 1_000;
/** Pages per listing per inbox poll; longer catch-ups skip ahead. */
const INBOX_MAX_PAGES = 50;
const COMMENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMENT_MAX_BODY_LENGTH = 60_000;
const MAX_PAGE = 1_000_000;
const CURSOR_MAX_LENGTH = 4_096;
const GITHUB_HOST = "github.com";
const decodeLinkedIssue = Schema.decodeEffect(ThreadLinkedIssue);
const sameIssueList = Schema.toEquivalence(IssueListResult);
const isIssueReadError = Schema.is(IssueReadError);
// ponytail: 10 pages (1,000 repos) caps the repository scan; raise it if an account outgrows it.
const REPOSITORY_MAX_PAGES = 10;

const IssueNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Page = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE }));
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

const GRAPHQL_PULL_REQUEST_FIELDS = "number title state isDraft url repository { nameWithOwner }";
const ISSUE_LINK_FIELDS = `closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
          nodes { ${GRAPHQL_PULL_REQUEST_FIELDS} }
        }
        timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent {
              source { __typename ... on PullRequest { ${GRAPHQL_PULL_REQUEST_FIELDS} } }
            }
          }
        }`;
/**
 * The issue with its linked pull requests. Without links it is the fallback read for an issue
 * whose cross-references GitHub partly refuses (an organization's SSO hides one), which fails
 * the whole GraphQL answer.
 */
const issueDetailQuery = (
  links: boolean,
) => `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number title body state stateReason createdAt updatedAt closedAt
        author { login avatarUrl }
        assignees(first: 100) { nodes { login avatarUrl } }
        labels(first: 100) { nodes { name color } }
        milestone {
          number title state dueOn
          openIssues: issues(states: OPEN) { totalCount }
          closedIssues: issues(states: CLOSED) { totalCount }
        }
        comments(last: ${DETAIL_COMMENT_LIMIT}) {
          totalCount
          nodes { author { login avatarUrl } body createdAt url }
        }
        ${links ? ISSUE_LINK_FIELDS : ""}
      }
    }
  }
}`;

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
const decodeCreatedIssueIdentity = Schema.decodeEffect(
  Schema.fromJsonString(RawIssueIdentitySchema),
);
const RawGitHubCommentSchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.NullOr(Schema.String),
});
const RawGitHubCommentListSchema = Schema.Array(RawGitHubCommentSchema);
const WorkIssueNode = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.Int,
  number: IssueNumber,
  title: Schema.String,
  url: GraphQlUrl,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  repository: Schema.Struct({ databaseId: Schema.Int, nameWithOwner: Schema.String }),
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
const GraphQlActorSchema = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
const GraphQlPullRequestSchema = Schema.Struct({
  __typename: Schema.optional(Schema.Literal("PullRequest")),
  number: IssueNumber,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  url: GraphQlUrl,
  repository: Schema.Struct({ nameWithOwner: TrimmedNonEmptyString }),
});
type GraphQlPullRequest = Schema.Schema.Type<typeof GraphQlPullRequestSchema>;
const GraphQlIssueSchema = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  number: IssueNumber,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["OPEN", "CLOSED"]),
  stateReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  author: Schema.NullOr(GraphQlActorSchema),
  assignees: graphQlNodes(GraphQlActorSchema),
  labels: Schema.NullOr(
    graphQlNodes(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        color: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{6}$/iu))),
      }),
    ),
  ),
  milestone: Schema.NullOr(
    Schema.Struct({
      number: IssueNumber,
      title: TrimmedNonEmptyString,
      state: Schema.Literals(["OPEN", "CLOSED"]),
      dueOn: Schema.NullOr(IsoDateTime),
      openIssues: Schema.Struct({ totalCount: NonNegativeInt }),
      closedIssues: Schema.Struct({ totalCount: NonNegativeInt }),
    }),
  ),
  comments: Schema.Struct({
    totalCount: NonNegativeInt,
    ...graphQlNodes(
      Schema.Struct({
        author: Schema.NullOr(GraphQlActorSchema),
        body: Schema.String,
        createdAt: IsoDateTime,
        url: GraphQlUrl,
      }),
    ).fields,
  }),
  closedByPullRequestsReferences: Schema.optional(
    Schema.NullOr(graphQlNodes(GraphQlPullRequestSchema)),
  ),
  timelineItems: Schema.optional(
    graphQlNodes(
      Schema.Struct({
        // Other sources (issues) carry only their __typename.
        source: Schema.optional(
          Schema.NullOr(
            Schema.Union([GraphQlPullRequestSchema, Schema.Struct({ __typename: Schema.String })]),
          ),
        ),
      }),
    ),
  ),
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
  stateReason: GraphQlIssueSchema.fields.stateReason,
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

type GraphQlIssue = Schema.Schema.Type<typeof GraphQlIssueSchema>;
const GraphQlIssueDetailResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            issueOrPullRequest: Schema.NullOr(
              Schema.Union([
                GraphQlIssueSchema,
                Schema.Struct({ __typename: Schema.Literal("PullRequest") }),
              ]),
            ),
          }),
        ),
      }),
    ),
  ),
});
const decodeGraphQlIssueDetail = Schema.decodeEffect(
  Schema.fromJsonString(GraphQlIssueDetailResponseSchema),
);

const IssueCursorSchema = Schema.Struct({
  v: Schema.Literal(2),
  state: Schema.Literals(["open", "all"]),
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  issuePage: Schema.NullOr(Page),
  milestonePage: Schema.NullOr(Page),
});
type IssueCursor = Schema.Schema.Type<typeof IssueCursorSchema>;
type RawIssue = Schema.Schema.Type<typeof RawIssueSchema>;

interface IssueRepositoryScope {
  readonly cwd: string;
  readonly host: string;
  readonly repository: string;
}

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

interface PageResult<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextPage: number | null;
  readonly etag?: string | undefined;
  readonly fetchedAt?: string;
  readonly generation?: number;
}

type ListMetadata = Effect.Success<ReturnType<typeof readIssueListMetadata>>;
interface IssuePageResult extends PageResult<IssueSummaryType> {
  readonly metadata?: Partial<Record<"projects" | "roadmap", ListMetadata>> | undefined;
}

const issueListEndpoint = (
  scope: IssueRepositoryScope,
  state: IssueListState,
  page: number,
  milestoneNumber?: number,
) =>
  `repos/${encodeRepositoryPath(scope.repository)}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}${milestoneNumber === undefined ? "" : `&milestone=${milestoneNumber}`}`;
const milestoneListEndpoint = (scope: IssueRepositoryScope, state: IssueListState, page: number) =>
  `repos/${encodeRepositoryPath(scope.repository)}/milestones?state=${state}&per_page=100&page=${page}`;

function readError(
  operation: IssueOperation,
  code: IssueReadError["code"],
  message: string,
  retryAt?: number,
  createOutcome?: IssueReadError["createOutcome"],
): IssueReadError {
  return new IssueReadError({
    code,
    operation,
    message,
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(createOutcome === undefined ? {} : { createOutcome }),
  });
}

function safeHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (
    host.length === 0 ||
    /\s/u.test(host) ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#")
  ) {
    return null;
  }
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
      ? host
      : null;
  } catch {
    return null;
  }
}

function safeRepository(host: string, value: string): string | null {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || /[\s\\?#]/u.test(part))) {
    return null;
  }
  const key = sourceControlDefinitions
    .canonicalRepositoryKey(`${host}/${parts.join("/")}`)
    .toLowerCase();
  const prefix = `${host.toLowerCase()}/`;
  const repository = key.startsWith(prefix) ? key.slice(prefix.length) : null;
  return repository !== null && repository.split("/").length === 2 ? repository : null;
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

function ensureCommentMarker(body: string, marker: string): string {
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

function normalizeGraphQlActor(actor: Schema.Schema.Type<typeof GraphQlActorSchema>): {
  readonly login: string;
  readonly avatarUrl: string | null;
} {
  return { login: actor.login, avatarUrl: normalizeAvatarUrl(actor.avatarUrl) };
}

function normalizeGraphQlIssue(
  host: string,
  repository: string,
  issue: GraphQlIssue,
): IssueSummaryType {
  const milestone = issue.milestone;
  return {
    number: issue.number,
    title: issue.title,
    url: issueUrl(host, repository, issue.number),
    state: issue.state === "OPEN" ? "open" : "closed",
    // GraphQL spells REST's `not_planned` as NOT_PLANNED.
    stateReason: issue.stateReason?.toLowerCase() ?? null,
    author: issue.author === null ? null : normalizeGraphQlActor(issue.author),
    assignees: presentNodes(issue.assignees).map(normalizeGraphQlActor),
    labels: presentNodes(issue.labels).map((label) => ({ name: label.name, color: label.color })),
    milestone:
      milestone === null
        ? null
        : {
            number: milestone.number,
            title: milestone.title,
            state: milestone.state === "OPEN" ? "open" : "closed",
            dueAt: milestone.dueOn,
            url: milestoneUrl(host, repository, milestone.number),
            openCount: milestone.openIssues.totalCount,
            closedCount: milestone.closedIssues.totalCount,
          },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt ?? null,
    commentCount: issue.comments.totalCount,
  };
}

/** Closing pull requests first, then ones that only mention the issue, each listed once. */
function linkedPullRequests(issue: GraphQlIssue): IssueLinkedPullRequest[] {
  const referencing = presentNodes(issue.timelineItems ?? null).flatMap(({ source }) =>
    source != null && "number" in source ? [source] : [],
  );
  const candidates: Array<readonly [GraphQlPullRequest, boolean]> = [
    ...presentNodes(issue.closedByPullRequestsReferences ?? null).map((pr) => [pr, true] as const),
    ...referencing.map((pr) => [pr, false] as const),
  ];
  const linked = new Map<string, IssueLinkedPullRequest>();
  for (const [pr, closesIssue] of candidates) {
    const key = `${pr.repository.nameWithOwner.toLowerCase()}#${pr.number}`;
    if (linked.has(key)) continue;
    linked.set(key, {
      repository: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      isDraft: pr.isDraft,
      url: pr.url,
      closesIssue,
    });
  }
  return [...linked.values()];
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

/**
 * What a GitHub failure means for an issue read or write. A write that tracks its create outcome
 * reports a refusal, or a request never sent, as `rejected` and a server error as `uncertain`;
 * a transport failure carries no outcome, since GitHub may have applied it.
 */
function mapGitHubError(
  operation: IssueOperation,
  error: GitHubPullRequestApi.GitHubPullRequestApiError,
  write?: { readonly tracksOutcome: boolean },
): IssueReadError {
  const outcome = (value: "rejected" | "uncertain") =>
    write?.tracksOutcome === true ? value : undefined;
  const inaccessible = (status: 403 | 404) =>
    new IssueResponseError({
      operation,
      code: "inaccessible",
      message:
        write === undefined
          ? "The GitHub repository is not accessible."
          : "GitHub issue write denied. Check repository access and Issues write permission.",
      createOutcome: outcome("rejected"),
      status,
    });
  const failed =
    write === undefined
      ? "GitHub could not complete the read."
      : "GitHub could not complete the issue write.";
  switch (error._tag) {
    case "GitHubCliMissingError":
      return readError(
        operation,
        "missing-tool",
        "No GitHub credential is available.",
        undefined,
        outcome("rejected"),
      );
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubCliFailedError":
    case "GitHubApiAuthenticationError":
      return readError(
        operation,
        "unauthenticated",
        "GitHub authentication is unavailable.",
        undefined,
        outcome("rejected"),
      );
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return readError(
        operation,
        "rate-limited",
        "GitHub API rate limit is active.",
        error.retryAt,
        outcome("rejected"),
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
          : readError(operation, "inaccessible", "GitHub did not return every requested field.");
      }
      return new IssueResponseError({
        operation,
        code: "upstream",
        message: failed,
        createOutcome: outcome(error.status < 500 ? "rejected" : "uncertain"),
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
export function selectIssueRepositories(
  host: string,
  viewerLogin: string,
  repositories: ReadonlyArray<RawRepository>,
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

const decodeIssueCursor = Schema.decodeUnknownOption(IssueCursorSchema);
const decodeRawIssueList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssueSchema)));
const decodeRawMilestoneList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawMilestoneSchema)),
);
const decodeRawRepositoryList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawRepositorySchema)),
);

function decodeCursor(raw: string): IssueCursor | null {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Option.getOrNull(decodeIssueCursor(parsed));
  } catch {
    return null;
  }
}

function encodeCursor(cursor: IssueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

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
interface RepositoryRequest {
  readonly host: string;
  readonly repository: string;
  readonly path: string;
  readonly method?: "POST" | "DELETE";
  readonly body?: unknown;
  readonly ifNoneMatch?: string;
}

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly readChangeState: (
      input: import("@t3tools/contracts").IssueRef,
    ) => Effect.Effect<IssueChangeBaseline, IssueReadError>;
    readonly createIssue: (
      input: IssueRepositoryRef & {
        readonly title: string;
        readonly body: string;
        readonly milestoneNumber: number | null;
        readonly writeKey: string;
        readonly recover?: boolean;
        readonly onCreated?: (issue: ThreadLinkedIssueType) => Effect.Effect<void, IssueReadError>;
      },
    ) => Effect.Effect<IssueChangeBaseline, IssueReadError>;
    readonly updateBody: (
      input: import("@t3tools/contracts").IssueRef & { readonly body: string },
    ) => Effect.Effect<void, IssueReadError>;
    readonly setMilestone: (
      input: import("@t3tools/contracts").IssueRef & { readonly milestoneNumber: number | null },
    ) => Effect.Effect<void, IssueReadError>;
    readonly setState: (
      input: import("@t3tools/contracts").IssueRef & { readonly state: "open" | "closed" },
    ) => Effect.Effect<void, IssueReadError>;
    readonly setSubIssue: (input: {
      readonly parent: ThreadLinkedIssueType;
      readonly child: ThreadLinkedIssueType;
      readonly action: "add" | "remove";
    }) => Effect.Effect<void, IssueReadError>;
    readonly repositories: () => Effect.Effect<IssueRepositoriesResultType, IssueReadError>;
    readonly refreshes: Stream.Stream<number>;
    readonly list: (
      input: IssueListInputType,
    ) => Effect.Effect<IssueListResultType, IssueReadError>;
    readonly statusBatch: (
      input: IssueStatusBatchInput,
    ) => Effect.Effect<ReadonlyArray<IssueStatusBatchResult[number] & IssueRef>, IssueReadError>;
    readonly detail: (
      input: IssueDetailInputType,
    ) => Effect.Effect<IssueDetailResultType, IssueReadError>;
    readonly workRead: (
      input: IssueDetailInputType,
    ) => Effect.Effect<IssueWorkRead, IssueReadError>;
    readonly milestoneIssues: (input: {
      readonly host: string;
      readonly repository: string;
      readonly milestoneNumber: number;
    }) => Effect.Effect<
      {
        readonly issues: ReadonlyArray<IssueSummaryType>;
        readonly complete: boolean;
        readonly missing?: true;
      },
      IssueReadError
    >;
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
    readonly writeManagedComment: (input: {
      readonly issue: ThreadLinkedIssueType;
      readonly operation: "status_sync" | "closeout_create";
      readonly commentId?: string;
      readonly marker: string;
      readonly body: string;
    }) => Effect.Effect<{ readonly commentId: string }, IssueReadError>;
    readonly activitySince: (
      scope: IssueRepositoryRef,
      cursors: ActivityCursors,
    ) => Effect.Effect<
      {
        readonly issues: ActivityPage<typeof InboxIssue.Type>;
        readonly comments: ActivityPage<typeof InboxComment.Type>;
        readonly stateChanges: ActivityPage<typeof InboxEvent.Type>;
        readonly eventsAfter: number;
      },
      IssueReadError
    >;
    readonly listComments: (
      ref: IssueRef,
      options?: {
        readonly maxPages?: number;
        /** Stops reading further pages once the comments read so far satisfy it. */
        readonly until?: (comments: ReadonlyArray<typeof InboxListedComment.Type>) => boolean;
      },
    ) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<typeof InboxListedComment.Type>;
        readonly complete: boolean;
      },
      IssueReadError
    >;
    readonly postComment: (
      ref: IssueRef,
      body: string,
    ) => Effect.Effect<typeof InboxPosted.Type, IssueReadError>;
    readonly postIssue: (
      scope: IssueRepositoryRef,
      input: {
        readonly title: string;
        readonly body: string;
        readonly labels: ReadonlyArray<string>;
      },
    ) => Effect.Effect<typeof InboxPosted.Type, IssueReadError>;
    readonly ensureLabels: (
      scope: IssueRepositoryRef,
      labels: ReadonlyArray<{ readonly name: string; readonly color: string }>,
    ) => Effect.Effect<void, IssueReadError>;
    readonly setLabels: (
      ref: IssueRef,
      add: ReadonlyArray<string>,
      remove: ReadonlyArray<string>,
    ) => Effect.Effect<void, IssueReadError>;
  }
>()("t3/issues/IssueService") {}

export const make = Effect.fn("IssueService.make")(function* (): Effect.fn.Return<
  IssueService["Service"],
  never,
  GitHubApi.GitHubApi | GitHubPullRequestApi.GitHubPullRequestApi | Scope.Scope
> {
  const api = yield* GitHubApi.GitHubApi;
  const githubPullRequests = yield* GitHubPullRequestApi.GitHubPullRequestApi;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const serviceScope = yield* Effect.scope;
  const refreshes = yield* SubscriptionRef.make(0);
  const repositoryGenerations = new Map<string, number>();
  const repositoryKey = (scope: IssueRepositoryScope) =>
    JSON.stringify([scope.host, scope.repository]);
  const repositoryGeneration = (scope: IssueRepositoryScope) =>
    repositoryGenerations.get(repositoryKey(scope)) ?? 0;
  const advanceRepositoryGeneration = (scope: IssueRepositoryScope) => {
    repositoryGenerations.set(repositoryKey(scope), repositoryGeneration(scope) + 1);
  };
  const makePageCaches = () => ({
    issues: new IssueListPageCache<IssuePageResult>(),
    refreshing: new Set<string>(),
    milestones: new IssueListPageCache<PageResult<IssueMilestone>>(),
  });
  // List subscriptions have no server-side lifetime signal. Release a repository after five
  // idle minutes; at most 16 repositories retain 32 issue and 32 milestone pages each.
  const pageCaches = yield* RcMap.make({
    lookup: (_key: string) => Effect.sync(makePageCaches),
    idleTimeToLive: "5 minutes",
    capacity: 16,
  });
  const repositoryPages = Effect.fn("IssueService.repositoryPages")(
    (scope: IssueRepositoryScope, credentialFingerprint: string) =>
      RcMap.get(
        pageCaches,
        JSON.stringify([scope.host, scope.repository, credentialFingerprint]),
      ).pipe(Effect.catchTags({ ExceededCapacityError: () => Effect.sync(makePageCaches) })),
  );

  const makeLiveReadCache = <A>() => {
    const reads = new Map<string, Effect.Effect<A, IssueReadError>>();
    return Effect.fn("IssueService.liveRead")(function* (
      key: string,
      read: Effect.Effect<A, IssueReadError>,
      refresh: boolean | undefined,
    ) {
      let cached = refresh === false ? reads.get(key) : undefined;
      if (cached === undefined) {
        cached = yield* Effect.cachedWithTTL(read, (exit) =>
          Exit.isSuccess(exit) ? LIVE_ISSUE_REFRESH_MS : 0,
        );
        reads.delete(key);
        reads.set(key, cached);
        if (reads.size > 256) reads.delete(reads.keys().next().value!);
      }
      return yield* cached;
    });
  };
  const liveStatuses =
    makeLiveReadCache<ReadonlyArray<IssueStatusBatchResult[number] & IssueRef>>();
  const liveDetails = makeLiveReadCache<IssueDetailResultType>();

  const resolveScope = Effect.fn("IssueService.resolveScope")(function* (
    operation: IssueOperation,
    input: { readonly host: string; readonly repository: string },
  ): Effect.fn.Return<IssueRepositoryScope, IssueReadError> {
    const host = safeHost(input.host);
    const repository = host === null ? null : safeRepository(host, input.repository);
    if (host === null || repository === null) {
      return yield* readError(
        operation,
        "scope-unavailable",
        "The repository cannot be addressed.",
      );
    }
    // Issue reads address the repository explicitly, so they need no project checkout.
    return { cwd: homeDirectory, host, repository };
  });

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
    readonly onRequest?: () => void;
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
    input.onRequest?.();
    const response = yield* send.pipe(
      Effect.mapError((error) =>
        mapGitHubError(
          input.operation,
          error,
          input.requestMethod === undefined
            ? undefined
            : { tracksOutcome: input.onRequest !== undefined },
        ),
      ),
    );
    if (input.requestMethod !== undefined) advanceRepositoryGeneration(input.scope);
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

  const findManagedComment = Effect.fn("IssueService.findManagedComment")(function* (
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

  const statusBatch: IssueService["Service"]["statusBatch"] = Effect.fn("IssueService.statusBatch")(
    function* (input) {
      const byHost = new Map<string, Set<string>>();
      for (const issue of input.issues) {
        const host = safeHost(issue.host);
        if (host === null)
          return yield* readError(
            "detail",
            "scope-unavailable",
            "The GitHub host cannot be addressed.",
          );
        let ids = byHost.get(host);
        if (ids === undefined) byHost.set(host, (ids = new Set()));
        ids.add(issue.nodeId);
      }
      const result: Array<IssueStatusBatchResult[number] & IssueRef> = [];
      for (const [host, nodeIds] of byHost) {
        yield* githubPullRequests
          .withVerifiedCredential({ cwd: homeDirectory, host }, (identity) =>
            Effect.gen(function* () {
              const statuses: typeof result = [];
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
                      (error.path[0] === "nodes" &&
                        (error.path.length < 2 || error.path[1] === index)),
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
                      state:
                        pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
                      updatedAt: pr.updatedAt,
                    })),
                  });
                }
              }
              return statuses;
            }).pipe((read) =>
              liveStatuses(
                JSON.stringify([
                  host,
                  identity.credentialFingerprint,
                  [...nodeIds].sort(),
                  [...repositoryGenerations],
                ]),
                read,
                input.refresh,
              ),
            ),
          )
          .pipe(
            Effect.tap((statuses) => Effect.sync(() => result.push(...statuses))),
            Effect.catch((error) =>
              Effect.logWarning("Could not read issue statuses for GitHub host", {
                host,
                code: (isIssueReadError(error) ? error : mapGitHubError("detail", error)).code,
              }),
            ),
          );
      }
      return result;
    },
  );

  const workRead: IssueService["Service"]["workRead"] = Effect.fn("IssueService.workRead")(
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
              if (node == null || (decoded.errors?.length ?? 0) > 0)
                return yield* readError(
                  "detail",
                  "inaccessible",
                  "Issue hierarchy or dependencies could not be read completely.",
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
  const repositoryIdentity: IssueService["Service"]["repositoryIdentity"] = Effect.fn(
    "IssueService.repositoryIdentity",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input);
    return yield* githubPullRequests
      .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, () =>
        readRepositoryIdentity(scope),
      )
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("detail", error),
        ),
      );
  });

  const resolveLinkedIssue: IssueService["Service"]["resolveLinkedIssue"] = Effect.fn(
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

  const writeManagedComment: IssueService["Service"]["writeManagedComment"] = Effect.fn(
    "IssueService.writeManagedComment",
  )(function* (input) {
    const scope = yield* resolveScope("detail", input.issue);
    const body = ensureCommentMarker(input.body, input.marker);
    return yield* githubPullRequests
      .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, () =>
        Effect.gen(function* () {
          const issueCommentsEndpoint = `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.issue.number}/comments`;
          const writeComment = (commentId?: string) =>
            executeApi({
              operation: "detail",
              scope,
              endpoint:
                commentId === undefined
                  ? issueCommentsEndpoint
                  : `repos/${encodeRepositoryPath(scope.repository)}/issues/comments/${commentId}`,
              maxOutputBytes: 256 * 1024,
              requestMethod: commentId === undefined ? "POST" : "PATCH",
              requestBody: { body },
            }).pipe(
              Effect.flatMap((response) =>
                decodeApiResponse(
                  "detail",
                  RawGitHubCommentSchema,
                  response,
                  "GitHub returned an invalid issue comment.",
                ),
              ),
              Effect.map((comment) => String(comment.id)),
            );
          const findByMarker = () => findManagedComment(scope, input.issue.number, input.marker);

          if (input.operation === "status_sync" && input.commentId !== undefined) {
            if (!/^\d+$/u.test(input.commentId)) {
              return yield* readError(
                "detail",
                "invalid-response",
                "The stored comment ID is invalid.",
              );
            }
            const currentComment = yield* Effect.result(writeComment(input.commentId));
            let updated: string;
            if (Result.isSuccess(currentComment)) {
              updated = currentComment.success;
            } else {
              if (currentComment.failure.code !== "inaccessible") {
                return yield* currentComment.failure;
              }
              const existing = yield* findByMarker();
              updated =
                existing === null
                  ? yield* writeComment()
                  : yield* writeComment(String(existing.id));
            }
            return { commentId: updated };
          }

          const existing = yield* findByMarker();
          const commentId =
            input.operation === "status_sync" && existing !== null
              ? yield* writeComment(String(existing.id))
              : existing === null
                ? yield* writeComment()
                : String(existing.id);
          return { commentId };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("detail", error),
        ),
      );
  });

  const listIssuePage = Effect.fn("IssueService.listIssuePage")(function* (
    scope: IssueRepositoryScope,
    cache: IssueListPageCache<IssuePageResult>,
    state: IssueListState,
    page: number,
    milestoneNumber?: number,
  ): Effect.fn.Return<IssuePageResult, IssueReadError> {
    const endpoint = issueListEndpoint(scope, state, page, milestoneNumber);
    const cached = cache.get(endpoint);
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint,
      ifNoneMatch: cached?.etag,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const nextPage =
      response.status === 304 && cached !== undefined && response.headers["link"] === undefined
        ? cached.page.nextPage
        : nextPageFromHeaders(response.headers, page);
    if (nextPage === undefined) {
      return yield* readError(
        "list",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    if (response.status === 304 && cached !== undefined) {
      const result = {
        ...cached.page,
        nextPage,
        etag: response.headers["etag"] ?? cached.etag,
      };
      return result;
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
      nextPage,
    };
    const pageResult = {
      ...result,
      etag: response.headers["etag"],
      metadata: cached?.page.metadata,
    };
    return pageResult;
  });

  const listMilestonePage = Effect.fn("IssueService.listMilestonePage")(function* (
    scope: IssueRepositoryScope,
    cache: IssueListPageCache<PageResult<IssueMilestone>>,
    state: IssueListState,
    page: number,
  ): Effect.fn.Return<PageResult<IssueMilestone>, IssueReadError> {
    const endpoint = milestoneListEndpoint(scope, state, page);
    const cached = cache.get(endpoint);
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint,
      ifNoneMatch: cached?.etag,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const nextPage =
      response.status === 304 && cached !== undefined && response.headers["link"] === undefined
        ? cached.page.nextPage
        : nextPageFromHeaders(response.headers, page);
    if (nextPage === undefined) {
      return yield* readError(
        "list",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    if (response.status === 304 && cached !== undefined) {
      const result = { ...cached.page, nextPage, etag: response.headers["etag"] ?? cached.etag };
      return result;
    }
    const raw = yield* decodeRawMilestoneList(response.body).pipe(
      Effect.mapError(() =>
        readError("list", "invalid-response", "GitHub returned an invalid milestone list."),
      ),
    );
    const result = {
      items: raw.map((milestone) => normalizeMilestone(scope.host, scope.repository, milestone)),
      nextPage,
    };
    const pageResult = { ...result, etag: response.headers["etag"] };
    return pageResult;
  });

  const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(function* (input) {
    const scope = yield* resolveScope("list", input);
    const state = input.state ?? "open";
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (
      input.cursor !== undefined &&
      (cursor === null ||
        cursor.state !== state ||
        cursor.host !== scope.host ||
        cursor.repository !== scope.repository)
    ) {
      return yield* readError(
        "list",
        "invalid-cursor",
        "The issue cursor is invalid for this repository.",
      );
    }
    return yield* githubPullRequests
      .withVerifiedCredential(
        { cwd: scope.cwd, host: scope.host },
        (
          identity,
        ): Effect.Effect<
          IssueListResultType,
          IssueReadError | GitHubPullRequestApi.GitHubPullRequestApiError
        > =>
          Effect.gen(function* () {
            if (cursor !== null && cursor.accountId !== identity.accountId) {
              return yield* readError(
                "list",
                "invalid-cursor",
                "The issue cursor is invalid for this account.",
              );
            }
            const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
            if (input.refresh === true) advanceRepositoryGeneration(scope);
            const generation = repositoryGeneration(scope);
            const issuePage = cursor === null ? 1 : cursor.issuePage;
            const milestonePage = cursor === null ? 1 : cursor.milestonePage;
            const issueEndpoint =
              issuePage === null ? null : issueListEndpoint(scope, state, issuePage);
            const milestoneEndpoint =
              milestonePage === null ? null : milestoneListEndpoint(scope, state, milestonePage);
            const mode = input.roadmap === true ? "roadmap" : "projects";
            const cachedIssues =
              issueEndpoint === null ? undefined : pages.issues.get(issueEndpoint)?.page;
            const cachedMilestones =
              milestoneEndpoint === null
                ? undefined
                : pages.milestones.get(milestoneEndpoint)?.page;
            const cachedMetadata = issuePage === null ? new Map() : cachedIssues?.metadata?.[mode];
            const assemble = Effect.fn("IssueService.assembleList")(function* (
              issueResult: IssuePageResult,
              milestoneResult: PageResult<IssueMilestone>,
              projects: ListMetadata,
              fetchedAt?: string,
            ) {
              const nextCursor =
                issueResult.nextPage === null && milestoneResult.nextPage === null
                  ? null
                  : encodeCursor({
                      v: 2,
                      state,
                      host: scope.host,
                      repository: scope.repository,
                      accountId: identity.accountId,
                      issuePage: issueResult.nextPage,
                      milestonePage: milestoneResult.nextPage,
                    });
              return {
                repository: { host: scope.host, repository: scope.repository },
                viewer: { accountId: identity.accountId, login: identity.viewer },
                fetchedAt: fetchedAt ?? DateTime.formatIso(yield* DateTime.now),
                issues: issueResult.items.map((issue) => ({
                  ...issue,
                  ...projects.get(issue.number),
                  projects: projects.get(issue.number)?.projects ?? [],
                })),
                milestones: milestoneResult.items,
                nextCursor,
                issuesComplete: issueResult.nextPage === null,
                milestonesComplete: milestoneResult.nextPage === null,
              } satisfies IssueListResultType;
            });
            const read = Effect.gen(function* () {
              const issueRead = yield* (
                issuePage === null
                  ? Effect.succeed<IssuePageResult>({ items: [], nextPage: null })
                  : listIssuePage(scope, pages.issues, state, issuePage)
              ).pipe(Effect.forkChild);
              const milestoneRead = yield* (
                milestonePage === null
                  ? Effect.succeed<PageResult<IssueMilestone>>({ items: [], nextPage: null })
                  : listMilestonePage(scope, pages.milestones, state, milestonePage)
              ).pipe(Effect.forkChild);
              const issueResult = yield* Fiber.join(issueRead);
              const [milestoneResult, projects] = yield* Effect.all(
                [
                  Fiber.join(milestoneRead),
                  readIssueListMetadata(
                    scope,
                    issueResult.items.map((issue) => issue.number),
                    input.roadmap === true,
                  ).pipe(Effect.provideService(GitHubApi.GitHubApi, api)),
                ],
                { concurrency: "unbounded" },
              );
              const result = yield* assemble(issueResult, milestoneResult, projects);
              // Commit only a complete read, so a failed refresh keeps the last good page.
              if (generation !== repositoryGeneration(scope)) return result;
              if (issueEndpoint !== null)
                pages.issues.set(issueEndpoint, issueResult.etag, {
                  ...issueResult,
                  generation,
                  fetchedAt: result.fetchedAt,
                  metadata: {
                    ...(pages.issues.get(issueEndpoint)?.page.generation === generation
                      ? pages.issues.get(issueEndpoint)?.page.metadata
                      : undefined),
                    [mode]: projects,
                  },
                });
              if (milestoneEndpoint !== null)
                pages.milestones.set(milestoneEndpoint, milestoneResult.etag, {
                  ...milestoneResult,
                  generation,
                  fetchedAt: result.fetchedAt,
                });
              return result;
            });
            if (
              (issuePage !== null && cachedIssues?.generation !== generation) ||
              (milestonePage !== null && cachedMilestones?.generation !== generation) ||
              cachedMetadata === undefined
            ) {
              return yield* read;
            }
            const cached = yield* assemble(
              cachedIssues ?? { items: [], nextPage: null },
              cachedMilestones ?? { items: [], nextPage: null },
              cachedMetadata,
              cachedIssues?.fetchedAt ?? cachedMilestones?.fetchedAt,
            );
            if (
              input.refresh === false &&
              (yield* Clock.currentTimeMillis) -
                DateTime.toEpochMillis(DateTime.makeUnsafe(cached.fetchedAt)) <
                LIVE_ISSUE_REFRESH_MS
            )
              return cached;
            const refreshKey = `${generation}:${state}:${issuePage}:${milestonePage}:${mode}`;
            if (!pages.refreshing.has(refreshKey)) {
              pages.refreshing.add(refreshKey);
              yield* Effect.gen(function* () {
                // Hold the repository lease until refresh completes, beyond this RPC's scope.
                yield* repositoryPages(scope, identity.credentialFingerprint);
                const fresh = yield* read;
                if (
                  generation === repositoryGeneration(scope) &&
                  !sameIssueList(cached, { ...fresh, fetchedAt: cached.fetchedAt })
                ) {
                  yield* SubscriptionRef.update(refreshes, (revision) => revision + 1);
                }
              }).pipe(
                Effect.scoped,
                Effect.provideService(SourceControlRateLimit.Interactive, false),
                Effect.catch((error) =>
                  Effect.logWarning("Could not refresh cached issue list", error),
                ),
                Effect.ensuring(Effect.sync(() => pages.refreshing.delete(refreshKey))),
                Effect.forkIn(serviceScope),
              );
            }
            return cached;
          }).pipe(Effect.scoped),
      )
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("list", error),
        ),
      );
  });

  const detail: IssueService["Service"]["detail"] = Effect.fn("IssueService.detail")(
    function* (input) {
      const scope = yield* resolveScope("detail", input);
      return yield* githubPullRequests
        .withVerifiedCredential(
          { cwd: scope.cwd, host: scope.host },
          (
            identity,
          ): Effect.Effect<
            IssueDetailResultType,
            IssueReadError | GitHubPullRequestApi.GitHubPullRequestApiError
          > =>
            Effect.gen(function* () {
              if (
                input.expectedAccountId !== undefined &&
                input.expectedAccountId !== identity.accountId
              ) {
                return yield* readError(
                  "detail",
                  "inaccessible",
                  "The issue is not accessible to this account.",
                );
              }
              const [owner, name] = scope.repository.split("/");
              const response = yield* executeApi({
                operation: "detail",
                scope,
                endpoint: "graphql",
                maxOutputBytes: DETAIL_MAX_OUTPUT_BYTES,
                graphql: {
                  query: issueDetailQuery(true),
                  variables: { owner: owner!, name: name!, number: input.number },
                  fallbackQuery: issueDetailQuery(false),
                },
              });
              const decoded = yield* decodeGraphQlIssueDetail(response.body).pipe(
                Effect.mapError(() =>
                  readError("detail", "invalid-response", "GitHub returned an invalid issue."),
                ),
              );
              // GitHubApi fails a NOT_FOUND answer; null data without one reads the same way.
              const raw = decoded.data?.repository?.issueOrPullRequest ?? null;
              if (raw === null) {
                return yield* readError(
                  "detail",
                  "inaccessible",
                  "The issue is not accessible to this account.",
                );
              }
              if (raw.__typename !== "Issue") {
                return yield* readError(
                  "detail",
                  "unsupported",
                  "Pull requests are not GitHub issues.",
                );
              }
              // The list's own metadata read for this one issue, so the detail can say blocked or
              // in progress as its row does. It never fails the detail.
              const metadata = yield* readIssueListMetadata(scope, [raw.number], true).pipe(
                Effect.provideService(GitHubApi.GitHubApi, api),
              );
              const { pullRequestRefs: _refs, ...relationships } = metadata.get(raw.number) ?? {};
              return {
                repository: { host: scope.host, repository: scope.repository },
                viewer: { accountId: identity.accountId, login: identity.viewer },
                fetchedAt: DateTime.formatIso(yield* DateTime.now),
                issue: {
                  ...normalizeGraphQlIssue(scope.host, scope.repository, raw),
                  ...relationships,
                },
                body: raw.body ?? "",
                comments: presentNodes(raw.comments).map((comment) => ({
                  author: comment.author === null ? null : normalizeGraphQlActor(comment.author),
                  body: comment.body,
                  createdAt: comment.createdAt,
                  url: comment.url,
                })),
                linkedPullRequests: linkedPullRequests(raw),
              } satisfies IssueDetailResultType;
            }).pipe((read) =>
              liveDetails(
                JSON.stringify([
                  scope.host,
                  scope.repository,
                  input.number,
                  input.expectedAccountId,
                  identity.accountId,
                  identity.credentialFingerprint,
                  repositoryGeneration(scope),
                ]),
                read,
                input.refresh,
              ),
            ),
        )
        .pipe(
          Effect.mapError((error) =>
            isIssueReadError(error) ? error : mapGitHubError("detail", error),
          ),
        );
    },
  );

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

  const repositories: IssueService["Service"]["repositories"] = Effect.fn(
    "IssueService.repositories",
  )(function* () {
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
              repositories: selectIssueRepositories(scope.host, identity.viewer, raw),
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
  });

  const milestoneIssues: IssueService["Service"]["milestoneIssues"] = Effect.fn(
    "IssueService.milestoneIssues",
  )(function* (input) {
    const scope = yield* resolveScope("list", input);
    return yield* githubPullRequests
      .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, (identity) =>
        Effect.gen(function* () {
          const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
          const generation = repositoryGeneration(scope);
          const issues: IssueSummaryType[] = [];
          let page: number | null = 1;
          for (let count = 0; count < 10 && page !== null; count++) {
            const result: PageResult<IssueSummaryType> = yield* listIssuePage(
              scope,
              pages.issues,
              "all",
              page,
              input.milestoneNumber,
            );
            if (generation === repositoryGeneration(scope))
              pages.issues.set(
                issueListEndpoint(scope, "all", page, input.milestoneNumber),
                result.etag,
                { ...result, generation },
              );
            issues.push(...result.items);
            page = result.nextPage;
          }
          return { issues, complete: page === null };
        }).pipe(
          Effect.scoped,
          // GitHub answers 422 for an invalid milestone and for its spam guard, so only a 404 from
          // the milestone itself proves it is missing. Any other answer keeps the list failure.
          Effect.catchIf(
            (error) => isIssueResponseError(error) && error.status === 422,
            (listError) =>
              executeApi({
                operation: "list",
                scope,
                endpoint: `repos/${encodeRepositoryPath(scope.repository)}/milestones/${input.milestoneNumber}`,
                maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
              }).pipe(
                Effect.matchEffect({
                  onSuccess: () => Effect.fail(listError),
                  onFailure: (lookupError) =>
                    isIssueResponseError(lookupError) && lookupError.status === 404
                      ? Effect.succeed({ issues: [], complete: true, missing: true as const })
                      : Effect.fail(listError),
                }),
              ),
          ),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("list", error),
        ),
      );
  });
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
  const verified = <A>(scope: IssueRepositoryScope, effect: Effect.Effect<A, IssueReadError>) =>
    githubPullRequests
      .withVerifiedCredential({ cwd: scope.cwd, host: scope.host }, () => effect)
      .pipe(
        Effect.mapError((error) =>
          isIssueReadError(error) ? error : mapGitHubError("detail", error),
        ),
      );
  const readChangeState: IssueService["Service"]["readChangeState"] = Effect.fn(
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
  const createIssue: IssueService["Service"]["createIssue"] = Effect.fn("IssueService.createIssue")(
    function* (input) {
      let attempted = false;
      const scope = yield* resolveScope("detail", input).pipe(
        Effect.mapError((error) =>
          readError(
            error.operation,
            error.code,
            error.message,
            error.retryAt,
            input.recover !== false ? "uncertain" : "rejected",
          ),
        ),
      );
      return yield* verified(
        scope,
        Effect.gen(function* () {
          const repository = yield* readRepositoryIdentity(scope);
          const endpoint = `repos/${encodeRepositoryPath(scope.repository)}/issues`;
          const marker = `<!-- t3-issue-change:${input.writeKey} -->`;
          // Recover an accepted create whose response or local receipt was lost. Never infer ownership from author login.
          for (let page = 1; input.recover !== false && page <= COMMENT_MAX_PAGES; page++) {
            const response = yield* executeApi({
              operation: "detail",
              scope,
              endpoint: `${endpoint}?state=all&per_page=100&page=${page}`,
              maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
            });
            const rows = yield* decodeApiResponse(
              "detail",
              Schema.Array(ChangeIssue),
              response,
              "GitHub returned an incomplete issue recovery page.",
            );
            const existing = rows.find(
              (row) => !Object.hasOwn(row, "pull_request") && row.body?.includes(marker),
            );
            if (existing !== undefined) return baseline(scope, repository.repositoryId, existing);
            if (rows.length < 100) break;
            if (page === COMMENT_MAX_PAGES)
              return yield* readError(
                "detail",
                "invalid-response",
                "Issue recovery pagination is incomplete; creation was not retried.",
              );
          }
          if (input.recover !== false)
            return yield* readError(
              "detail",
              "upstream",
              "The earlier create may have succeeded, but its marker was not found. Check GitHub and mark this change resolved; submit a new proposal only if another create is intended.",
              undefined,
              "unresolved",
            );
          const response = yield* executeApi({
            operation: "detail",
            scope,
            endpoint,
            onRequest: () => {
              attempted = true;
            },
            requestMethod: "POST",
            requestBody: {
              title: input.title,
              body: `${input.body}\n\n${marker}`,
              milestone: input.milestoneNumber,
            },
            maxOutputBytes: 256 * 1024,
          });
          // Persist the identity before decoding mutable issue fields: a malformed body
          // or state must not discard a successful create receipt.
          const identity = yield* decodeCreatedIssueIdentity(response.body).pipe(Effect.option);
          if (Option.isSome(identity) && !Object.hasOwn(identity.value, "pull_request")) {
            const raw = identity.value;
            yield* (
              input.onCreated?.({
                host: scope.host,
                repository: scope.repository,
                repositoryId: repository.repositoryId,
                id: String(raw.id),
                nodeId: raw.node_id,
                number: raw.number,
                title: raw.title,
                url: raw.html_url,
              }) ?? Effect.void
            );
          }
          return baseline(
            scope,
            repository.repositoryId,
            yield* decodeApiResponse(
              "detail",
              ChangeIssue,
              response,
              "GitHub returned an invalid created issue.",
            ),
          );
        }),
      ).pipe(
        Effect.mapError((error) =>
          readError(
            error.operation,
            error.code,
            error.message,
            error.retryAt,
            input.recover !== false
              ? error.createOutcome === "unresolved"
                ? "unresolved"
                : "uncertain"
              : attempted
                ? (error.createOutcome ?? "uncertain")
                : "rejected",
          ),
        ),
      );
    },
  );
  const patchIssue = Effect.fn("IssueService.patchIssue")(function* (
    input: import("@t3tools/contracts").IssueRef,
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
  const setSubIssue: IssueService["Service"]["setSubIssue"] = Effect.fn("IssueService.setSubIssue")(
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
          Effect.mapError((error) =>
            mapGitHubError(
              "detail",
              error,
              input.method === undefined ? undefined : { tracksOutcome: false },
            ),
          ),
        ),
    );
    if (input.method !== undefined) advanceRepositoryGeneration(scope);
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
  const activitySince: IssueService["Service"]["activitySince"] = Effect.fn(
    "IssueService.activitySince",
  )(function* (scope, cursors) {
    if (cursors.initial) {
      const response = yield* inboxRequest({ ...scope, path: "issues/events?per_page=100&page=1" });
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
  const listComments: IssueService["Service"]["listComments"] = Effect.fn(
    "IssueService.listComments",
  )(function* (ref, options) {
    const result = yield* readActivityPages(
      ref,
      `issues/${ref.number}/comments?per_page=100`,
      InboxListedComment,
      null,
      options?.until,
      options?.maxPages ?? Infinity,
    );
    return { comments: result.items, complete: result.complete };
  });
  const postComment: IssueService["Service"]["postComment"] = Effect.fn("IssueService.postComment")(
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
  const postIssue: IssueService["Service"]["postIssue"] = Effect.fn("IssueService.postIssue")(
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
  const ensureLabels: IssueService["Service"]["ensureLabels"] = Effect.fn(
    "IssueService.ensureLabels",
  )(function* (scope, labels) {
    const response = yield* inboxRequest({ ...scope, path: "labels?per_page=100" });
    const existing = new Set(
      (yield* decodeInbox(Schema.Array(Schema.Struct({ name: Schema.String })), response.body)).map(
        (label) => label.name.toLowerCase(),
      ),
    );
    for (const label of labels)
      if (!existing.has(label.name.toLowerCase()))
        yield* inboxRequest({ ...scope, path: "labels", method: "POST", body: label }).pipe(
          Effect.catch(() => Effect.void),
        );
  });
  const setLabels: IssueService["Service"]["setLabels"] = Effect.fn("IssueService.setLabels")(
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
  return IssueService.of({
    refreshes: SubscriptionRef.changes(refreshes),
    activitySince,
    listComments,
    postComment,
    postIssue,
    ensureLabels,
    setLabels,
    readChangeState,
    createIssue,
    updateBody: Effect.fn("IssueService.updateBody")((input) =>
      patchIssue(input, { body: input.body }),
    ),
    setMilestone: Effect.fn("IssueService.setMilestone")((input) =>
      patchIssue(input, { milestone: input.milestoneNumber }),
    ),
    setState: Effect.fn("IssueService.setState")((input) =>
      patchIssue(input, { state: input.state }),
    ),
    setSubIssue,
    repositories,
    list,
    detail,
    workRead,
    statusBatch,
    milestoneIssues,
    repositoryIdentity,
    resolveLinkedIssue,
    writeManagedComment,
  });
});

export const layer = Layer.effect(IssueService, make());
