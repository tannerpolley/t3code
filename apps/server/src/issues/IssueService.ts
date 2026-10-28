import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import {
  IssueMilestone,
  IssueReadError,
  type IssueDetailResult as IssueDetailResultType,
  type IssueStatusBatchResult,
  type IssueListInput as IssueListInputType,
  type IssueListResult as IssueListResultType,
  type IssueListState,
  type IssueRef,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { IssueListPageCache } from "./IssueListPageCache.ts";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as IssueForgejoHost from "./IssueForgejoHost.ts";
import * as IssueGitHubHost from "./IssueGitHubHost.ts";
import {
  issueHostFor,
  type IssueHost,
  type IssueRepositoryScope,
  type IssuePageResult,
  type PageResult,
  type PageResponse,
  type ListMetadata,
} from "./IssueHost.ts";
import { LIVE_ISSUE_REFRESH_MS, IssueListResult, TrimmedNonEmptyString } from "@t3tools/contracts";
const MAX_PAGE = 1_000_000;
const CURSOR_MAX_LENGTH = 4_096;
const Page = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE }));
const sameIssueList = Schema.toEquivalence(IssueListResult);
type IssueOperation = IssueReadError["operation"];
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
const issueListEndpoint = (
  _scope: IssueRepositoryScope,
  state: IssueListState,
  page: number,
  milestoneNumber?: number,
) => `${state}:${page}:${milestoneNumber ?? ""}`;
const milestoneListEndpoint = (_scope: IssueRepositoryScope, state: IssueListState, page: number) =>
  `${state}:${page}`;
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

const decodeIssueCursor = Schema.decodeUnknownOption(IssueCursorSchema);
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

export class IssueService extends Context.Service<
  IssueService,
  Omit<
    IssueHost,
    "withIdentity" | "listIssuePage" | "listMilestonePage" | "listMetadata" | "detail" | "statuses"
  > & {
    readonly isForgejoHost: (host: string) => Effect.Effect<boolean>;
    readonly milestoneIssues: (input: {
      readonly host: string;
      readonly repository: string;
      readonly milestoneNumber: number;
    }) => Effect.Effect<
      {
        readonly issues: ReadonlyArray<import("@t3tools/contracts").IssueSummary>;
        readonly complete: boolean;
        readonly missing?: true;
      },
      IssueReadError
    >;
    readonly statusBatch: (
      input: import("@t3tools/contracts").IssueStatusBatchInput,
    ) => ReturnType<IssueHost["statuses"]>;
    readonly detail: (
      input: import("@t3tools/contracts").IssueDetailInput,
    ) => Effect.Effect<IssueDetailResultType, IssueReadError>;
    readonly refreshes: Stream.Stream<number>;
    readonly list: (
      input: IssueListInputType,
    ) => Effect.Effect<IssueListResultType, IssueReadError>;
  }
>()("t3/issues/IssueService") {}
export const make = Effect.fn("IssueService.make")(function* () {
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

  const github = yield* IssueGitHubHost.make({
    safeRepository,
    resolveScope,
  });
  const cli = Option.getOrUndefined(yield* Effect.serviceOption(ForgejoCli.ForgejoCli));
  const forgejo = new Map<string, IssueHost>();
  const logins = yield* (
    cli?.listLogins?.({ cwd: homeDirectory, command: "fj" }) ?? Effect.succeed([])
  ).pipe(
    Effect.catch(() => Effect.logWarning("Forgejo login discovery failed").pipe(Effect.as([]))),
  );
  for (const login of logins) {
    forgejo.set(
      login.name,
      yield* IssueForgejoHost.make({ safeRepository, resolveScope }, login.name).pipe(
        Effect.provideService(ForgejoCli.ForgejoCli, cli!),
      ),
    );
  }
  const hostFor = (host: string) => issueHostFor(host, github, forgejo);
  const pageResult = <A>(
    response: PageResponse<A>,
    cached: { readonly page: PageResult<A>; readonly etag: string | undefined } | undefined,
  ): Effect.Effect<PageResult<A>, IssueReadError> => {
    if (!("notModified" in response)) return Effect.succeed(response);
    if (cached === undefined)
      return Effect.fail(
        readError("list", "invalid-response", "The issue host returned an uncached page."),
      );
    return Effect.succeed({
      ...cached.page,
      nextPage: response.nextPage === undefined ? cached.page.nextPage : response.nextPage,
      etag: response.etag ?? cached.etag,
    });
  };
  const readIssuePage = Effect.fn("IssueService.readIssuePage")(function* (
    scope: IssueRepositoryScope,
    pages: ReturnType<typeof makePageCaches>,
    state: IssueListState,
    page: number,
    milestoneNumber?: number,
  ): Effect.fn.Return<IssuePageResult & { readonly missing?: true }, IssueReadError> {
    const cached = pages.issues.get(issueListEndpoint(scope, state, page, milestoneNumber));
    const response = yield* hostFor(scope.host).listIssuePage(
      scope,
      state,
      page,
      milestoneNumber,
      cached?.etag,
    );
    if (response.missing) return { items: [], nextPage: null, missing: true as const };
    return yield* pageResult(response, cached);
  });
  const readMilestonePage = Effect.fn("IssueService.readMilestonePage")(function* (
    scope: IssueRepositoryScope,
    pages: ReturnType<typeof makePageCaches>,
    state: IssueListState,
    page: number,
  ) {
    const cached = pages.milestones.get(milestoneListEndpoint(scope, state, page));
    return yield* pageResult(
      yield* hostFor(scope.host).listMilestonePage(scope, state, page, cached?.etag),
      cached,
    );
  });
  const milestoneIssues: IssueService["Service"]["milestoneIssues"] = Effect.fn(
    "IssueService.milestoneIssues",
  )(function* (input) {
    const scope = yield* resolveScope("list", input);
    return yield* hostFor(scope.host).withIdentity(scope, "list", (identity) =>
      Effect.gen(function* () {
        const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
        const generation = repositoryGeneration(scope);
        const issues: Array<import("@t3tools/contracts").IssueSummary> = [];
        let page: number | null = 1;
        for (let count = 0; count < 10 && page !== null; count++) {
          const result: IssuePageResult & { readonly missing?: true } = yield* readIssuePage(
            scope,
            pages,
            "all",
            page,
            input.milestoneNumber,
          );
          if (result.missing) return { issues: [], complete: true, missing: true as const };
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
      }).pipe(Effect.scoped),
    );
  });
  const afterWrite = Effect.fn("IssueService.afterWrite")(function* <A>(
    input: { readonly host: string; readonly repository: string },
    write: Effect.Effect<A, IssueReadError>,
  ) {
    const scope = yield* resolveScope("detail", input);
    const result = yield* write;
    advanceRepositoryGeneration(scope);
    return result;
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
    return yield* hostFor(scope.host).withIdentity(
      scope,
      "list",
      (identity): Effect.Effect<IssueListResultType, IssueReadError> =>
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
            milestoneEndpoint === null ? undefined : pages.milestones.get(milestoneEndpoint)?.page;
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
                : readIssuePage(scope, pages, state, issuePage)
            ).pipe(Effect.forkChild);
            const milestoneRead = yield* (
              milestonePage === null
                ? Effect.succeed<PageResult<IssueMilestone>>({ items: [], nextPage: null })
                : readMilestonePage(scope, pages, state, milestonePage)
            ).pipe(Effect.forkChild);
            const issueResult = yield* Fiber.join(issueRead);
            const [milestoneResult, projects] = yield* Effect.all(
              [
                Fiber.join(milestoneRead),
                hostFor(scope.host).listMetadata(
                  scope,
                  issueResult.items.map((issue) => issue.number),
                  input.roadmap === true,
                ),
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
    );
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
        yield* hostFor(host)
          .withIdentity({ cwd: homeDirectory, host, repository: "" }, "detail", (identity) =>
            hostFor(host)
              .statuses(host, [...nodeIds])
              .pipe((read) =>
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
                code: error.code,
              }),
            ),
          );
      }
      return result;
    },
  );

  const detail: IssueService["Service"]["detail"] = Effect.fn("IssueService.detail")(
    function* (input) {
      const scope = yield* resolveScope("detail", input);
      return yield* hostFor(scope.host).withIdentity(scope, "detail", (identity) =>
        hostFor(scope.host)
          .detail(input, identity)
          .pipe((read) =>
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
      );
    },
  );
  return IssueService.of({
    isForgejoHost: Effect.fn("IssueService.isForgejoHost")((host) =>
      Effect.succeed(forgejo.has(host.toLowerCase())),
    ),
    refreshes: SubscriptionRef.changes(refreshes),
    list,
    readChangeState: Effect.fn("IssueService.readChangeState")((input) =>
      hostFor(input.host).readChangeState(input),
    ),
    createIssue: Effect.fn("IssueService.createIssue")((input) =>
      afterWrite(input, hostFor(input.host).createIssue(input)),
    ),
    updateBody: Effect.fn("IssueService.updateBody")((input) =>
      afterWrite(input, hostFor(input.host).updateBody(input)),
    ),
    setMilestone: Effect.fn("IssueService.setMilestone")((input) =>
      afterWrite(input, hostFor(input.host).setMilestone(input)),
    ),
    setState: Effect.fn("IssueService.setState")((input) =>
      afterWrite(input, hostFor(input.host).setState(input)),
    ),
    detail,
    workRead: Effect.fn("IssueService.workRead")((input) => hostFor(input.host).workRead(input)),
    milestoneIssues,
    repositoryIdentity: Effect.fn("IssueService.repositoryIdentity")((input) =>
      hostFor(input.host).repositoryIdentity(input),
    ),
    resolveLinkedIssue: Effect.fn("IssueService.resolveLinkedIssue")((input) =>
      hostFor(input.host).resolveLinkedIssue(input),
    ),
    activitySince: Effect.fn("IssueService.activitySince")((input, ...args) =>
      hostFor(input.host).activitySince(input, ...args),
    ),
    listComments: Effect.fn("IssueService.listComments")((input, ...args) =>
      hostFor(input.host).listComments(input, ...args),
    ),
    postComment: Effect.fn("IssueService.postComment")((input, ...args) =>
      afterWrite(input, hostFor(input.host).postComment(input, ...args)),
    ),
    postIssue: Effect.fn("IssueService.postIssue")((input, ...args) =>
      afterWrite(input, hostFor(input.host).postIssue(input, ...args)),
    ),
    ensureLabels: Effect.fn("IssueService.ensureLabels")((input, ...args) =>
      afterWrite(input, hostFor(input.host).ensureLabels(input, ...args)),
    ),
    setLabels: Effect.fn("IssueService.setLabels")((input, ...args) =>
      afterWrite(input, hostFor(input.host).setLabels(input, ...args)),
    ),
    repositories: Effect.fn("IssueService.repositories")(function* () {
      if (forgejo.size === 0) return yield* github.repositories();
      const results = yield* Effect.forEach(
        [github, ...forgejo.values()],
        (transport) => transport.repositories().pipe(Effect.result),
        { concurrency: 8 },
      );
      const successful = results.flatMap((result) =>
        result._tag === "Success" ? [result.success] : [],
      );
      if (successful.length === 0) {
        const first = results[0]!;
        if (first._tag === "Failure") return yield* first.failure;
      }
      return {
        ...successful[0]!,
        repositories: successful.flatMap((result) => result.repositories),
        complete:
          successful.length === results.length && successful.every((result) => result.complete),
      };
    }),
    statusBatch,
    setParent: Effect.fn("IssueService.setParent")((input) =>
      afterWrite(input.parent, hostFor(input.parent.host).setParent(input)),
    ),
    writeManagedComment: Effect.fn("IssueService.writeManagedComment")((input) =>
      afterWrite(input.issue, hostFor(input.issue.host).writeManagedComment(input)),
    ),
  });
});
export const layer = Layer.effect(IssueService, make()).pipe(Layer.provide(ForgejoCli.layer));
