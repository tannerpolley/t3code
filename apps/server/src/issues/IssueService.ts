import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";

import {
  IssueMilestone,
  IssueReadError,
  type IssueStatusBatchResult,
  type IssueRepositoryRef,
  type RepositoryIssueListState,
  type IssueHostCapabilities,
  type RepositoryIssueRef,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { IssueListPageCache } from "./IssueListPageCache.ts";
import {
  make as makeGitHubExtension,
  type IssueGitHubExtension,
  type IssuePullRequestFacts,
  type IssueRepositoryScope,
  type IssuePageResult,
  type PageResult,
  type PageResponse,
  type ListMetadata,
} from "./IssueGitHubExtension.ts";
import { LIVE_ISSUE_REFRESH_MS } from "@t3tools/contracts";
type IssueOperation = IssueReadError["operation"];
const issueListEndpoint = (
  _scope: IssueRepositoryScope,
  state: RepositoryIssueListState,
  page: number,
  milestoneNumber?: number,
) => `${state}:${page}:${milestoneNumber ?? ""}`;
const milestoneListEndpoint = (
  _scope: IssueRepositoryScope,
  state: RepositoryIssueListState,
  page: number,
) => `${state}:${page}`;
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

export const completionIssueKey = ({ host, repository, number }: RepositoryIssueRef) =>
  JSON.stringify([host, repository, number]);

export class IssueService extends Context.Service<
  IssueService,
  Omit<
    IssueGitHubExtension,
    | "withIdentity"
    | "listIssuePage"
    | "listMilestonePage"
    | "listMetadata"
    | "statuses"
    | "issueStatuses"
    | "workRead"
    | "workReads"
    | "capabilities"
    | "pullRequest"
  > & {
    readonly canonicalHost: (host: string) => Effect.Effect<string>;
    /** What the issue host serving `host` supports. */
    readonly capabilities: (host: string) => Effect.Effect<IssueHostCapabilities>;
    /** Null where the host's adapter cannot read pull request merge facts. */
    readonly pullRequest: (
      input: RepositoryIssueRef & { readonly cwd: string },
    ) => Effect.Effect<IssuePullRequestFacts | null, IssueReadError>;
    readonly repositoryIssuesPage: (
      input: IssueRepositoryRef & {
        readonly state: RepositoryIssueListState;
        readonly page: number;
      },
    ) => Effect.Effect<IssuePageResult, IssueReadError>;
    readonly milestoneIssues: (input: {
      readonly host: string;
      readonly repository: string;
      readonly milestoneNumber: number;
    }) => Effect.Effect<
      {
        readonly issues: ReadonlyArray<import("@t3tools/contracts").RepositoryIssueSummary>;
        readonly complete: boolean;
        readonly missing?: true;
      },
      IssueReadError
    >;
    readonly statusBatch: (
      input: import("@t3tools/contracts").IssueStatusBatchInput,
    ) => ReturnType<IssueGitHubExtension["statuses"]>;
    readonly issueStatuses: (
      refs: ReadonlyArray<RepositoryIssueRef>,
      refresh?: boolean,
    ) => Effect.Effect<ReadonlyArray<import("./IssueGitHubExtension.ts").IssueCompletionStatus>>;
    readonly workRead: (
      input: RepositoryIssueRef,
      options?: { readonly cached?: boolean },
    ) => ReturnType<IssueGitHubExtension["workRead"]>;
    readonly workReads: (
      input: IssueRepositoryRef,
      numbers: ReadonlyArray<number>,
    ) => ReturnType<IssueGitHubExtension["workReads"]>;
    /** One page of the repository's milestones, a conditional read that is free when unchanged. */
    readonly milestones: (
      input: IssueRepositoryRef & {
        readonly state: RepositoryIssueListState;
        readonly page: number;
      },
    ) => Effect.Effect<PageResult<IssueMilestone>, IssueReadError>;
    /** The roadmap facts upstream's issue rows lack, for the given issues; None when GitHub failed. */
    readonly overlay: (
      input: IssueRepositoryRef & {
        readonly numbers: ReadonlyArray<number>;
        readonly refresh?: boolean | undefined;
      },
    ) => Effect.Effect<Option.Option<ListMetadata>>;
    /** Advances after a write through this service or new activity read for the repository. */
    readonly revision: (input: IssueRepositoryRef) => Effect.Effect<number>;
    /** Advances the revision for an issue write made outside this service. */
    readonly markChanged: (input: IssueRepositoryRef) => Effect.Effect<void>;
    /**
     * One element per revision advance from a write, for clients that re-read issues on it. An
     * activity read advances silently; the inbox poll that made it notifies once it commits.
     */
    readonly subscribeRevisions: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/issues/IssueService") {}
/** Per-key reads share in-flight work and respect GitHub's retry deadline. */
export const makeLiveReadCache = <A>(
  ttl: number | ((value: A) => number) = LIVE_ISSUE_REFRESH_MS,
) => {
  const reads = new Map<
    string,
    {
      read: Effect.Effect<A, IssueReadError>;
      revision: string | number | undefined;
      failureUntil: number;
    }
  >();
  return Effect.fn("IssueService.liveRead")(function* (
    key: string,
    read: Effect.Effect<A, IssueReadError>,
    refresh: boolean | undefined,
    revision?: string | number,
  ) {
    const clock = yield* Clock.clockWith(Effect.succeed);
    let entry = reads.get(key);
    if (
      entry === undefined ||
      ((refresh === true || revision !== entry.revision) &&
        clock.currentTimeMillisUnsafe() >= entry.failureUntil)
    ) {
      let failureUntil = 0;
      const cached = yield* Effect.cachedWithTTL(
        read.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              failureUntil = error.retryAt ?? clock.currentTimeMillisUnsafe() + 60_000;
            }),
          ),
        ),
        (exit) => {
          if (Exit.isSuccess(exit)) return typeof ttl === "function" ? ttl(exit.value) : ttl;
          return Math.max(0, failureUntil - clock.currentTimeMillisUnsafe());
        },
      );
      entry = {
        read: cached,
        revision,
        get failureUntil() {
          return failureUntil;
        },
      };
      reads.delete(key);
      reads.set(key, entry);
      if (reads.size > 256) reads.delete(reads.keys().next().value!);
    }
    return yield* entry.read;
  });
};
export const make = Effect.fn("IssueService.make")(function* () {
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const repositoryGenerations = new Map<string, number>();
  const hostGenerations = new Map<string, number>();
  const repositoryKey = (scope: IssueRepositoryRef) =>
    JSON.stringify([scope.host, scope.repository]);
  const repositoryGeneration = (scope: IssueRepositoryRef) =>
    repositoryGenerations.get(repositoryKey(scope)) ?? 0;
  const revisionChanges = yield* PubSub.sliding<void>(1);
  const bumpRepositoryGeneration = (scope: IssueRepositoryScope) => {
    repositoryGenerations.set(repositoryKey(scope), repositoryGeneration(scope) + 1);
    hostGenerations.set(scope.host, (hostGenerations.get(scope.host) ?? 0) + 1);
  };
  const advanceRepositoryGeneration = (scope: IssueRepositoryScope) =>
    Effect.suspend(() => {
      bumpRepositoryGeneration(scope);
      return PubSub.publish(revisionChanges, undefined);
    });
  const makePageCaches = () => ({
    issues: new IssueListPageCache<IssuePageResult>(),
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

  const liveStatuses =
    makeLiveReadCache<ReadonlyArray<IssueStatusBatchResult[number] & RepositoryIssueRef>>();

  const completionStatuses = makeLiveReadCache<
    ReadonlyArray<import("./IssueGitHubExtension.ts").IssueCompletionStatus>
  >(5 * 60_000);
  const liveWorkRead = makeLiveReadCache<import("@t3tools/contracts").IssueWorkRead>(5 * 60_000);
  const liveWorkReads = makeLiveReadCache<
    ReadonlyMap<number, import("@t3tools/contracts").IssueWorkRead>
  >(5 * 60_000);

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

  const github: IssueGitHubExtension = yield* makeGitHubExtension({
    safeRepository,
    resolveScope,
    onLabelsChanged: advanceRepositoryGeneration,
  });
  // Hosts whose credential lacks `read:project`, by credential, so the overlay stops asking.
  const withoutProjectScope = new Set<string>();
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
    state: RepositoryIssueListState,
    page: number,
    milestoneNumber?: number,
  ): Effect.fn.Return<IssuePageResult & { readonly missing?: true }, IssueReadError> {
    const cached = pages.issues.get(issueListEndpoint(scope, state, page, milestoneNumber));
    const response = yield* github.listIssuePage(scope, state, page, milestoneNumber, cached?.etag);
    if (response.missing) return { items: [], nextPage: null, missing: true as const };
    return yield* pageResult(response, cached);
  });
  const readMilestonePage = Effect.fn("IssueService.readMilestonePage")(function* (
    scope: IssueRepositoryScope,
    pages: ReturnType<typeof makePageCaches>,
    state: RepositoryIssueListState,
    page: number,
  ): Effect.fn.Return<PageResult<IssueMilestone>, IssueReadError> {
    const host = github;
    if (!host.capabilities.milestones) return { items: [], nextPage: null };
    const cached = pages.milestones.get(milestoneListEndpoint(scope, state, page));
    return yield* pageResult(
      yield* host.listMilestonePage(scope, state, page, cached?.etag),
      cached,
    );
  });
  const repositoryIssuesPage: IssueService["Service"]["repositoryIssuesPage"] = Effect.fn(
    "IssueService.repositoryIssuesPage",
  )(function* (input) {
    const scope = yield* resolveScope("list", input);
    return yield* github.withIdentity(scope, "list", (identity) =>
      Effect.gen(function* () {
        const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
        const result = yield* readIssuePage(scope, pages, input.state, input.page);
        pages.issues.set(issueListEndpoint(scope, input.state, input.page), result.etag, result);
        return result;
      }).pipe(Effect.scoped),
    );
  });
  const milestoneIssues: IssueService["Service"]["milestoneIssues"] = Effect.fn(
    "IssueService.milestoneIssues",
  )(function* (input) {
    const scope = yield* resolveScope("list", input);
    return yield* github.withIdentity(scope, "list", (identity) =>
      Effect.gen(function* () {
        const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
        const generation = repositoryGeneration(scope);
        const issues: Array<import("@t3tools/contracts").RepositoryIssueSummary> = [];
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
  const milestones: IssueService["Service"]["milestones"] = Effect.fn("IssueService.milestones")(
    function* (input) {
      const scope = yield* resolveScope("list", input);
      return yield* github.withIdentity(scope, "list", (identity) =>
        Effect.gen(function* () {
          const pages = yield* repositoryPages(scope, identity.credentialFingerprint);
          const result = yield* readMilestonePage(scope, pages, input.state, input.page);
          pages.milestones.set(
            milestoneListEndpoint(scope, input.state, input.page),
            result.etag,
            result,
          );
          return result;
        }).pipe(Effect.scoped),
      );
    },
  );
  const afterWrite = Effect.fn("IssueService.afterWrite")(function* <A>(
    input: { readonly host: string; readonly repository: string },
    write: Effect.Effect<A, IssueReadError>,
  ) {
    const scope = yield* resolveScope("detail", input);
    const result = yield* write;
    yield* advanceRepositoryGeneration(scope);
    return result;
  });
  const statusBatch: IssueService["Service"]["statusBatch"] = Effect.fn("IssueService.statusBatch")(
    function* (input) {
      const byHost = new Map<
        string,
        { ids: Set<string>; repositories: Set<string>; legacy: boolean }
      >();
      for (const issue of input.issues) {
        const host = safeHost(issue.host);
        if (host === null)
          return yield* readError(
            "detail",
            "scope-unavailable",
            "The GitHub host cannot be addressed.",
          );
        let batch = byHost.get(host);
        if (batch === undefined)
          byHost.set(host, (batch = { ids: new Set(), repositories: new Set(), legacy: false }));
        batch.ids.add(issue.nodeId);
        const repository =
          issue.repository === undefined ? null : safeRepository(host, issue.repository);
        if (repository === null) batch.legacy = true;
        else batch.repositories.add(repository);
      }
      const result: Array<IssueStatusBatchResult[number] & RepositoryIssueRef> = [];
      for (const [host, { ids, repositories, legacy }] of byHost) {
        const nodeIds = [...ids];
        yield* github
          .withIdentity({ cwd: homeDirectory, host, repository: "" }, "detail", (identity) =>
            liveStatuses(
              JSON.stringify([host, identity.credentialFingerprint, nodeIds.toSorted()]),
              github.statuses(host, nodeIds),
              input.refresh,
              JSON.stringify(
                legacy
                  ? (hostGenerations.get(host) ?? 0)
                  : [...repositories]
                      .sort()
                      .map((repository) => [
                        repository,
                        repositoryGeneration({ host, repository }),
                      ]),
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

  const issueStatuses: IssueService["Service"]["issueStatuses"] = Effect.fn(
    "IssueService.issueStatuses",
  )(function* (refs, refresh) {
    const unique = new Map<string, RepositoryIssueRef>();
    for (const ref of refs) {
      const scope = yield* resolveScope("detail", ref).pipe(Effect.option);
      if (scope._tag === "None") continue;
      const { host, repository } = scope.value;
      const normalized = { ...ref, host, repository };
      unique.set(completionIssueKey(normalized), normalized);
    }
    const result: import("./IssueGitHubExtension.ts").IssueCompletionStatus[] = [];
    for (const [host, batch] of Map.groupBy(unique.values(), (ref) => ref.host)) {
      const sorted = batch.sort(
        (a, b) => a.repository.localeCompare(b.repository) || a.number - b.number,
      );
      const revisions = [...new Set(sorted.map((ref) => ref.repository))].map((repository) =>
        repositoryGeneration({ host, repository }),
      );
      const statuses = yield* github
        .withIdentity(
          { cwd: homeDirectory, host, repository: "" },
          "detail",
          ({ credentialFingerprint }) =>
            completionStatuses(
              JSON.stringify([credentialFingerprint, sorted]),
              github.issueStatuses(host, sorted),
              refresh,
              JSON.stringify(revisions),
            ),
        )
        .pipe(Effect.orElseSucceed(() => []));
      result.push(...statuses);
    }
    return result;
  });

  return IssueService.of({
    canonicalHost: Effect.fn("IssueService.canonicalHost")((host) => Effect.succeed(host)),
    capabilities: Effect.fn("IssueService.capabilities")((_host) =>
      Effect.succeed(github.capabilities),
    ),
    pullRequest: Effect.fn("IssueService.pullRequest")((input) => github.pullRequest(input)),
    milestones,
    overlay: Effect.fn("IssueService.overlay")(function* (input) {
      const scope = yield* resolveScope("list", input).pipe(Effect.option);
      if (scope._tag === "None") return Option.some(new Map());
      return yield* github
        .withIdentity(scope.value, "list", ({ credentialFingerprint }) => {
          const key = JSON.stringify([scope.value.host, credentialFingerprint]);
          return github.listMetadata(scope.value, input.numbers, {
            granted: !withoutProjectScope.has(key),
            revoke: () => withoutProjectScope.add(key),
          });
        })
        .pipe(Effect.orElseSucceed(() => Option.none()));
    }),
    revision: Effect.fn("IssueService.revision")(function* (input) {
      const scope = yield* resolveScope("list", input).pipe(Effect.option);
      return scope._tag === "None" ? 0 : repositoryGeneration(scope.value);
    }),
    markChanged: Effect.fn("IssueService.markChanged")(function* (input) {
      const scope = yield* resolveScope("list", input).pipe(Effect.option);
      if (scope._tag === "Some") yield* advanceRepositoryGeneration(scope.value);
    }),
    subscribeRevisions: PubSub.subscribe(revisionChanges),
    withRepositoryCredential: github.withRepositoryCredential,
    readChangeState: Effect.fn("IssueService.readChangeState")((input) =>
      github.readChangeState(input),
    ),
    findCreatedIssue: Effect.fn("IssueService.findCreatedIssue")((input) =>
      github.findCreatedIssue(input),
    ),
    setMilestone: Effect.fn("IssueService.setMilestone")((input) =>
      afterWrite(input, github.setMilestone(input)),
    ),
    workRead: Effect.fn("IssueService.workRead")(function* (input, options) {
      if (options?.cached !== true) return yield* github.workRead(input);
      const scope = yield* resolveScope("detail", input);
      return yield* github.withIdentity(scope, "detail", ({ credentialFingerprint }) =>
        liveWorkRead(
          JSON.stringify([repositoryKey(scope), credentialFingerprint, input.number]),
          github.workRead(input),
          false,
          repositoryGeneration(scope),
        ),
      );
    }),
    workReads: Effect.fn("IssueService.workReads")(function* (input, numbers) {
      if (numbers.length === 0) return new Map();
      const scope = yield* resolveScope("detail", input);
      const sorted = [...new Set(numbers)].sort((left, right) => left - right);
      return yield* github.withIdentity(scope, "detail", ({ credentialFingerprint }) =>
        liveWorkReads(
          JSON.stringify([repositoryKey(scope), credentialFingerprint, sorted]),
          github.workReads(scope, sorted),
          false,
          repositoryGeneration(scope),
        ),
      );
    }),
    issueStatuses,
    repositoryIssuesPage,
    milestoneIssues,
    repositoryIdentity: Effect.fn("IssueService.repositoryIdentity")((input) =>
      github.repositoryIdentity(input),
    ),
    resolveLinkedIssue: Effect.fn("IssueService.resolveLinkedIssue")((input) =>
      github.resolveLinkedIssue(input),
    ),
    activitySince: Effect.fn("IssueService.activitySince")(function* (input, cursors) {
      const activity = yield* github.activitySince(input, cursors);
      if (
        activity.issues.items.length > 0 ||
        activity.comments.items.length > 0 ||
        activity.stateChanges.items.some((event) => event.id > cursors.eventsAfter)
      ) {
        bumpRepositoryGeneration(yield* resolveScope("list", input));
      }
      return activity;
    }),
    listComments: Effect.fn("IssueService.listComments")((input, ...args) =>
      github.listComments(input, ...args),
    ),
    postComment: Effect.fn("IssueService.postComment")((input, ...args) =>
      afterWrite(input, github.postComment(input, ...args)),
    ),
    postIssue: Effect.fn("IssueService.postIssue")((input, ...args) =>
      afterWrite(input, github.postIssue(input, ...args)),
    ),
    ensureLabels: github.ensureLabels,
    setLabels: github.setLabels,
    repositories: github.repositories,
    statusBatch,
    setBlockedBy: Effect.fn("IssueService.setBlockedBy")((input) =>
      afterWrite(input.issue, github.setBlockedBy(input)),
    ),
    setParent: Effect.fn("IssueService.setParent")((input) =>
      afterWrite(input.parent, github.setParent(input)),
    ),
    findManagedComment: Effect.fn("IssueService.findManagedComment")((input) =>
      github.findManagedComment(input),
    ),
    updateManagedComment: github.updateManagedComment,
  });
});
export const layer = Layer.effect(IssueService, make());
