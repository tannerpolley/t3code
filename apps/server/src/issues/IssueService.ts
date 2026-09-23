import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  IssueMilestone,
  IssueReadError,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type IssueDetailInput as IssueDetailInputType,
  type IssueDetailResult as IssueDetailResultType,
  type IssueLinkedPullRequest,
  type IssueListInput as IssueListInputType,
  type IssueListResult as IssueListResultType,
  type IssueListState,
  type IssueRepositoriesResult as IssueRepositoriesResultType,
  type IssueRepositorySummary,
  type IssueSummary as IssueSummaryType,
} from "@t3tools/contracts";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";

const API_TIMEOUT_MS = 30_000;
const LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// A detail read carries up to DETAIL_COMMENT_LIMIT comment bodies of up to 64 KiB each.
const DETAIL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DETAIL_COMMENT_LIMIT = 100;
const MAX_PAGE = 1_000_000;
const CURSOR_MAX_LENGTH = 4_096;
const GITHUB_HOST = "github.com";
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
  comments: NonNegativeInt,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
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
const ISSUE_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number title body state stateReason createdAt updatedAt
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
        closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
          nodes { ${GRAPHQL_PULL_REQUEST_FIELDS} }
        }
        timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent {
              source { __typename ... on PullRequest { ${GRAPHQL_PULL_REQUEST_FIELDS} } }
            }
          }
        }
      }
    }
  }
}`;

const encodeGraphQlRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
);

/** A connection whose nodes GitHub may null out, e.g. when an organization's SSO hides one. */
const graphQlNodes = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.NullOr(node))) });
const GraphQlUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/iu));
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
  closedByPullRequestsReferences: Schema.NullOr(graphQlNodes(GraphQlPullRequestSchema)),
  timelineItems: graphQlNodes(
    Schema.Struct({
      // Other sources (issues) carry only their __typename.
      source: Schema.optional(
        Schema.NullOr(
          Schema.Union([GraphQlPullRequestSchema, Schema.Struct({ __typename: Schema.String })]),
        ),
      ),
    }),
  ),
});
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
const GraphQlErrorsSchema = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
});
const decodeGraphQlIssueDetail = Schema.decodeEffect(
  Schema.fromJsonString(GraphQlIssueDetailResponseSchema),
);
const decodeGraphQlErrors = Schema.decodeUnknownOption(Schema.fromJsonString(GraphQlErrorsSchema));

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

interface ApiResponse {
  readonly body: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly status: number;
  readonly httpEnvelope: boolean;
}

interface PageResult<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextPage: number | null;
}

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
  const key = canonicalRepositoryKey(`${host}/${parts.join("/")}`).toLowerCase();
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
    commentCount: issue.comments,
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
    commentCount: issue.comments.totalCount,
  };
}

/** Closing pull requests first, then ones that only mention the issue, each listed once. */
function linkedPullRequests(issue: GraphQlIssue): IssueLinkedPullRequest[] {
  const referencing = presentNodes(issue.timelineItems).flatMap(({ source }) =>
    source != null && "number" in source ? [source] : [],
  );
  const candidates: Array<readonly [GraphQlPullRequest, boolean]> = [
    ...presentNodes(issue.closedByPullRequestsReferences).map((pr) => [pr, true] as const),
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

function responseFromStdout(stdout: string): ApiResponse | null {
  const lines = stdout.split(/\r?\n/u);
  const statusIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^HTTP\/\d(?:\.\d+)?\s+\d{3}\b/iu.test(line));
  const statusLine = statusIndexes.at(-1);
  if (statusLine === undefined) {
    return { body: stdout, headers: new Map(), status: 200, httpEnvelope: false };
  }
  const statusMatch = /^HTTP\/\d(?:\.\d+)?\s+(\d{3})\b/iu.exec(statusLine.line);
  const status = Number(statusMatch?.[1]);
  if (!Number.isInteger(status)) return null;
  const bodyStart = lines.findIndex(
    (line, index) => index > statusLine.index && line.trim().length === 0,
  );
  if (bodyStart < 0) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(statusLine.index + 1, bodyStart)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { body: lines.slice(bodyStart + 1).join("\n"), headers, status, httpEnvelope: true };
}

function nextPageFromHeaders(
  headers: ReadonlyMap<string, string>,
  page: number,
): number | null | undefined {
  const link = headers.get("link");
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

function retryAtFromHeaders(headers: ReadonlyMap<string, string>, now: number): number | undefined {
  const retryAfter = SourceControlRateLimit.retryAtFromHeader(headers.get("retry-after"), now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isSafeInteger(reset)) return undefined;
  const retryAt = reset * 1_000;
  return retryAt > now ? retryAt : undefined;
}

function isRateLimitedResponse(response: ApiResponse): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        (response.headers.get("retry-after")?.trim().length ?? 0) > 0))
  );
}

function mapGitHubError(
  operation: IssueOperation,
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): IssueReadError {
  switch (error._tag) {
    case "GitHubCliUnavailableError":
      return readError(operation, "missing-tool", "GitHub CLI is not available.");
    case "GitHubCliAuthenticationError":
      return readError(operation, "unauthenticated", "GitHub authentication is unavailable.");
    case "GitHubCliRateLimitError":
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
    case "GitHubPullRequestNotFoundError":
      return readError(operation, "inaccessible", "The GitHub repository is not accessible.");
    case "GitHubPullRequestListDecodeError":
    case "GitHubChangeRequestListDecodeError":
    case "GitHubPullRequestDecodeError":
    case "GitHubRepositoryDecodeError":
    case "GitHubPullRequestReadError":
      return readError(operation, "invalid-response", "GitHub returned an invalid response.");
    case "GitHubRepositorySelectorError":
      return readError(
        operation,
        "scope-unavailable",
        "The registered repository cannot be addressed.",
      );
    default:
      return readError(operation, "upstream", "GitHub could not complete the read.");
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

function decodeCursor(raw: string): IssueCursor | null {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Option.getOrNull(Schema.decodeUnknownOption(IssueCursorSchema)(parsed));
  } catch {
    return null;
  }
}

function encodeCursor(cursor: IssueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly repositories: () => Effect.Effect<IssueRepositoriesResultType, IssueReadError>;
    readonly list: (
      input: IssueListInputType,
    ) => Effect.Effect<IssueListResultType, IssueReadError>;
    readonly detail: (
      input: IssueDetailInputType,
    ) => Effect.Effect<IssueDetailResultType, IssueReadError>;
  }
>()("t3/issues/IssueService") {}

export const make = Effect.fn("IssueService.make")(function* (): Effect.fn.Return<
  IssueService["Service"],
  never,
  | GitHubCli.GitHubCli
  | GitHubPullRequestCli.GitHubPullRequestCli
  | SourceControlRateLimit.SourceControlRateLimit
> {
  const github = yield* GitHubCli.GitHubCli;
  const githubPullRequests = yield* GitHubPullRequestCli.GitHubPullRequestCli;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;

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
    // Issue reads address the repository explicitly, so gh needs no project checkout.
    return { cwd: NodeOS.homedir(), host, repository };
  });

  const executeApi = Effect.fn("IssueService.executeApi")(function* (input: {
    readonly operation: IssueOperation;
    readonly scope: IssueRepositoryScope;
    readonly endpoint: string;
    readonly maxOutputBytes: number;
    /** Sent over stdin to the `graphql` endpoint. */
    readonly graphql?: {
      readonly query: string;
      readonly variables: Readonly<Record<string, string | number>>;
    };
  }): Effect.fn.Return<ApiResponse, IssueReadError> {
    const key = { provider: "github" as const, host: input.scope.host };
    const lease = yield* rateLimits
      .check(key)
      .pipe(
        Effect.mapError((error) =>
          readError(
            input.operation,
            "rate-limited",
            "GitHub API rate limit is active.",
            error.retryAt,
          ),
        ),
      );
    return yield* github
      .execute({
        cwd: input.scope.cwd,
        args:
          input.graphql === undefined
            ? ["api", "--include", "--hostname", input.scope.host, input.endpoint]
            : ["api", "--include", "--hostname", input.scope.host, "graphql", "--input", "-"],
        ...(input.graphql === undefined ? {} : { stdin: encodeGraphQlRequest(input.graphql) }),
        timeoutMs: API_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.mapError((error) => mapGitHubError(input.operation, error)),
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            if (result.stdoutTruncated || result.stderrTruncated) {
              return yield* readError(
                input.operation,
                "invalid-response",
                "GitHub returned a truncated response.",
              );
            }
            const response = responseFromStdout(result.stdout);
            // gh also exits non-zero for a 200 GraphQL answer that carries errors; the caller
            // reads those from the body.
            if (
              response === null ||
              (result.exitCode !== 0 &&
                (!response.httpEnvelope || (response.status < 400 && input.graphql === undefined)))
            ) {
              return yield* readError(
                input.operation,
                "invalid-response",
                "GitHub returned an invalid response.",
              );
            }
            const graphQlRateLimited =
              input.graphql !== undefined &&
              Option.match(decodeGraphQlErrors(response.body), {
                onNone: () => false,
                onSome: ({ errors }) => errors?.some((e) => e.type === "RATE_LIMITED") === true,
              });
            if (graphQlRateLimited || isRateLimitedResponse(response)) {
              const retryAt = retryAtFromHeaders(response.headers, yield* Clock.currentTimeMillis);
              return yield* readError(
                input.operation,
                "rate-limited",
                "GitHub API rate limit is active.",
                retryAt,
              );
            }
            if (response.status === 401) {
              return yield* readError(
                input.operation,
                "unauthenticated",
                "GitHub authentication is unavailable.",
              );
            }
            if (response.status === 403 || response.status === 404) {
              return yield* readError(
                input.operation,
                "inaccessible",
                "The GitHub repository is not accessible.",
              );
            }
            if (response.status < 200 || response.status >= 300) {
              return yield* readError(
                input.operation,
                "upstream",
                "GitHub could not complete the read.",
              );
            }
            return response;
          }),
        ),
        Effect.tapError((error) =>
          error.code === "rate-limited"
            ? rateLimits.recordRateLimit({
                ...key,
                lease,
                ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
              })
            : Effect.void,
        ),
        Effect.tap(() => rateLimits.recordSuccess({ ...key, lease })),
      );
  });

  const listIssuePage = Effect.fn("IssueService.listIssuePage")(function* (
    scope: IssueRepositoryScope,
    state: IssueListState,
    page: number,
  ): Effect.fn.Return<PageResult<IssueSummaryType>, IssueReadError> {
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssueSchema)))(
      response.body,
    ).pipe(
      Effect.mapError(() =>
        readError("list", "invalid-response", "GitHub returned an invalid issue list."),
      ),
    );
    const nextPage = nextPageFromHeaders(response.headers, page);
    if (nextPage === undefined) {
      return yield* readError(
        "list",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    return {
      items: raw
        .filter((issue) => !Object.hasOwn(issue, "pull_request"))
        .map((issue) => normalizeIssue(scope.host, scope.repository, issue)),
      nextPage,
    };
  });

  const listMilestonePage = Effect.fn("IssueService.listMilestonePage")(function* (
    scope: IssueRepositoryScope,
    state: IssueListState,
    page: number,
  ): Effect.fn.Return<PageResult<IssueMilestone>, IssueReadError> {
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint: `repos/${encodeRepositoryPath(scope.repository)}/milestones?state=${state}&per_page=100&page=${page}`,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    });
    const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawMilestoneSchema)))(
      response.body,
    ).pipe(
      Effect.mapError(() =>
        readError("list", "invalid-response", "GitHub returned an invalid milestone list."),
      ),
    );
    const nextPage = nextPageFromHeaders(response.headers, page);
    if (nextPage === undefined) {
      return yield* readError(
        "list",
        "invalid-response",
        "GitHub returned invalid pagination metadata.",
      );
    }
    return {
      items: raw.map((milestone) => normalizeMilestone(scope.host, scope.repository, milestone)),
      nextPage,
    };
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
          IssueReadError | GitHubPullRequestCli.GitHubPullRequestCliError
        > =>
          Effect.gen(function* () {
            if (cursor !== null && cursor.accountId !== identity.accountId) {
              return yield* readError(
                "list",
                "invalid-cursor",
                "The issue cursor is invalid for this account.",
              );
            }
            const issuePage = cursor === null ? 1 : cursor.issuePage;
            const milestonePage = cursor === null ? 1 : cursor.milestonePage;
            const issueResult =
              issuePage === null
                ? { items: [], nextPage: null }
                : yield* listIssuePage(scope, state, issuePage);
            const milestoneResult =
              milestonePage === null
                ? { items: [], nextPage: null }
                : yield* listMilestonePage(scope, state, milestonePage);
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
              fetchedAt: DateTime.formatIso(yield* DateTime.now),
              issues: issueResult.items,
              milestones: milestoneResult.items,
              nextCursor,
              issuesComplete: issueResult.nextPage === null,
              milestonesComplete: milestoneResult.nextPage === null,
            } satisfies IssueListResultType;
          }),
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(IssueReadError)(error) ? error : mapGitHubError("list", error),
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
            IssueReadError | GitHubPullRequestCli.GitHubPullRequestCliError
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
                  query: ISSUE_DETAIL_QUERY,
                  variables: { owner: owner!, name: name!, number: input.number },
                },
              });
              const decoded = yield* decodeGraphQlIssueDetail(response.body).pipe(
                Effect.mapError(() =>
                  readError("detail", "invalid-response", "GitHub returned an invalid issue."),
                ),
              );
              // A missing repository or number comes back as null data plus a NOT_FOUND error.
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
              return {
                repository: { host: scope.host, repository: scope.repository },
                viewer: { accountId: identity.accountId, login: identity.viewer },
                fetchedAt: DateTime.formatIso(yield* DateTime.now),
                issue: normalizeGraphQlIssue(scope.host, scope.repository, raw),
                body: raw.body ?? "",
                comments: presentNodes(raw.comments).map((comment) => ({
                  author: comment.author === null ? null : normalizeGraphQlActor(comment.author),
                  body: comment.body,
                  createdAt: comment.createdAt,
                  url: comment.url,
                })),
                linkedPullRequests: linkedPullRequests(raw),
              } satisfies IssueDetailResultType;
            }),
        )
        .pipe(
          Effect.mapError((error) =>
            Schema.is(IssueReadError)(error) ? error : mapGitHubError("detail", error),
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
    const items = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(RawRepositorySchema)),
    )(response.body).pipe(
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
      cwd: NodeOS.homedir(),
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
          IssueReadError | GitHubPullRequestCli.GitHubPullRequestCliError
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
          Schema.is(IssueReadError)(error) ? error : mapGitHubError("repositories", error),
        ),
      );
  });

  return IssueService.of({ repositories, list, detail });
});

export const layer: Layer.Layer<
  IssueService,
  never,
  | GitHubCli.GitHubCli
  | GitHubPullRequestCli.GitHubPullRequestCli
  | SourceControlRateLimit.SourceControlRateLimit
> = Layer.effect(IssueService, make());
