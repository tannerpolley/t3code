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
  ProjectId,
  TrimmedNonEmptyString,
  type IssueDetailInput as IssueDetailInputType,
  type IssueDetailResult as IssueDetailResultType,
  type IssueListInput as IssueListInputType,
  type IssueListResult as IssueListResultType,
  type IssueSummary as IssueSummaryType,
  pullRequestHostOf,
} from "@t3tools/contracts";
import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const API_TIMEOUT_MS = 30_000;
const LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DETAIL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PAGE = 1_000_000;
const CURSOR_MAX_LENGTH = 4_096;

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

const IssueCursorSchema = Schema.Struct({
  v: Schema.Literal(1),
  projectId: ProjectId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  issuePage: Schema.NullOr(Page),
  milestonePage: Schema.NullOr(Page),
});
type IssueCursor = Schema.Schema.Type<typeof IssueCursorSchema>;
type RawIssue = Schema.Schema.Type<typeof RawIssueSchema>;

interface IssueProjectScope {
  readonly cwd: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly host: string;
  readonly repository: string;
}

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
  operation: "list" | "detail",
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
  operation: "list" | "detail",
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
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | GitHubCli.GitHubCli
  | GitHubPullRequestCli.GitHubPullRequestCli
  | SourceControlRateLimit.SourceControlRateLimit
> {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const github = yield* GitHubCli.GitHubCli;
  const githubPullRequests = yield* GitHubPullRequestCli.GitHubPullRequestCli;
  const rateLimits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const resolveScope = Effect.fn("IssueService.resolveScope")(function* (
    operation: "list" | "detail",
    input: {
      readonly projectId: ProjectId;
      readonly host?: string | undefined;
      readonly repository?: string | undefined;
    },
  ): Effect.fn.Return<IssueProjectScope, IssueReadError> {
    const project = yield* projections
      .getProjectShellById(input.projectId)
      .pipe(
        Effect.mapError(() =>
          readError(operation, "scope-unavailable", "The registered project is unavailable."),
        ),
      );
    return yield* Option.match(project, {
      onNone: () =>
        Effect.fail(
          readError(operation, "scope-unavailable", "The registered project is unavailable."),
        ),
      onSome: (value) => {
        const identity = value.repositoryIdentity;
        if (
          identity === undefined ||
          identity === null ||
          identity.provider?.toLowerCase() !== "github"
        ) {
          return Effect.fail(
            readError(operation, "unsupported", "The project is not a GitHub repository."),
          );
        }
        const host = safeHost(pullRequestHostOf(identity, "github"));
        const repository = sourceControlRepositorySelector(identity);
        const canonicalRepository =
          host === null || repository === null ? null : safeRepository(host, repository);
        if (host === null || host === "github" || canonicalRepository === null) {
          return Effect.fail(
            readError(operation, "scope-unavailable", "The registered repository is unavailable."),
          );
        }
        if (
          input.host !== undefined &&
          (safeHost(input.host) !== host || safeHost(input.host) === null)
        ) {
          return Effect.fail(
            readError(
              operation,
              "scope-unavailable",
              "The requested host is outside the project scope.",
            ),
          );
        }
        if (
          input.repository !== undefined &&
          (safeRepository(host, input.repository) !== canonicalRepository ||
            safeRepository(host, input.repository) === null)
        ) {
          return Effect.fail(
            readError(
              operation,
              "scope-unavailable",
              "The requested repository is outside the project scope.",
            ),
          );
        }
        return Effect.succeed({
          cwd: value.workspaceRoot,
          projectId: value.id,
          projectTitle: value.title,
          host,
          repository: canonicalRepository,
        });
      },
    });
  });

  const executeApi = Effect.fn("IssueService.executeApi")(function* (input: {
    readonly operation: "list" | "detail";
    readonly scope: IssueProjectScope;
    readonly endpoint: string;
    readonly maxOutputBytes: number;
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
        args: ["api", "--include", "--hostname", input.scope.host, input.endpoint],
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
            if (
              response === null ||
              (result.exitCode !== 0 && (!response.httpEnvelope || response.status < 400))
            ) {
              return yield* readError(
                input.operation,
                "invalid-response",
                "GitHub returned an invalid response.",
              );
            }
            if (isRateLimitedResponse(response)) {
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
    scope: IssueProjectScope,
    page: number,
  ): Effect.fn.Return<PageResult<IssueSummaryType>, IssueReadError> {
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
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
    scope: IssueProjectScope,
    page: number,
  ): Effect.fn.Return<PageResult<IssueMilestone>, IssueReadError> {
    const response = yield* executeApi({
      operation: "list",
      scope,
      endpoint: `repos/${encodeRepositoryPath(scope.repository)}/milestones?state=open&per_page=100&page=${page}`,
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
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (
      input.cursor !== undefined &&
      (cursor === null ||
        cursor.projectId !== scope.projectId ||
        cursor.host !== scope.host ||
        cursor.repository !== scope.repository)
    ) {
      return yield* readError(
        "list",
        "invalid-cursor",
        "The issue cursor is invalid for this project.",
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
                : yield* listIssuePage(scope, issuePage);
            const milestoneResult =
              milestonePage === null
                ? { items: [], nextPage: null }
                : yield* listMilestonePage(scope, milestonePage);
            const nextCursor =
              issueResult.nextPage === null && milestoneResult.nextPage === null
                ? null
                : encodeCursor({
                    v: 1,
                    projectId: scope.projectId,
                    host: scope.host,
                    repository: scope.repository,
                    accountId: identity.accountId,
                    issuePage: issueResult.nextPage,
                    milestonePage: milestoneResult.nextPage,
                  });
            return {
              repository: {
                projectId: scope.projectId,
                host: scope.host,
                repository: scope.repository,
              },
              projectTitle: scope.projectTitle,
              workspaceRoot: scope.cwd,
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
              if (
                input.host.toLowerCase() !== scope.host ||
                safeRepository(scope.host, input.repository) !== scope.repository
              ) {
                return yield* readError(
                  "detail",
                  "scope-unavailable",
                  "The requested issue is outside the project scope.",
                );
              }
              const response = yield* executeApi({
                operation: "detail",
                scope,
                endpoint: `repos/${encodeRepositoryPath(scope.repository)}/issues/${input.number}`,
                maxOutputBytes: DETAIL_MAX_OUTPUT_BYTES,
              });
              const raw = yield* Schema.decodeEffect(Schema.fromJsonString(RawIssueSchema))(
                response.body,
              ).pipe(
                Effect.mapError(() =>
                  readError("detail", "invalid-response", "GitHub returned an invalid issue."),
                ),
              );
              if (Object.hasOwn(raw, "pull_request")) {
                return yield* readError(
                  "detail",
                  "unsupported",
                  "Pull requests are not GitHub issues.",
                );
              }
              const issue = normalizeIssue(scope.host, scope.repository, raw);
              return {
                repository: {
                  projectId: scope.projectId,
                  host: scope.host,
                  repository: scope.repository,
                },
                projectTitle: scope.projectTitle,
                workspaceRoot: scope.cwd,
                viewer: { accountId: identity.accountId, login: identity.viewer },
                fetchedAt: DateTime.formatIso(yield* DateTime.now),
                issue,
                body: raw.body ?? "",
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

  return IssueService.of({ list, detail });
});

export const layer: Layer.Layer<
  IssueService,
  never,
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | GitHubCli.GitHubCli
  | GitHubPullRequestCli.GitHubPullRequestCli
  | SourceControlRateLimit.SourceControlRateLimit
> = Layer.effect(IssueService, make());

