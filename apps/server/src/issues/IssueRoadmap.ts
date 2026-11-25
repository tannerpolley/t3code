import {
  IssueReadError,
  type IssueActor,
  type IssueDetailInput,
  type IssueDetailResult,
  type IssueMilestone,
  type IssueRepositoryRef,
  type IssueStatusBatchInput,
  type IssueStatusBatchResult,
  type IssueSummary,
  type RepositoryIssueListInput,
  type RepositoryIssueListResult,
  type RepositoryIssueSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TrackerIssueService from "../issue/IssueService.ts";
import type { ListMetadata } from "./IssueGitHubExtension.ts";
import { fromTrackerError, trackerIssueRef } from "./trackerIssueRef.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueService from "./IssueService.ts";

const ROWS_MAX_AGE_MS = 5 * 60_000;
const INCOMPLETE_ROWS_MAX_AGE_MS = 60_000;
const PageNumber = Schema.Int.check(Schema.isGreaterThan(0));

const Position = Schema.Struct({
  issues: Schema.NullOr(PageNumber),
  milestones: Schema.NullOr(PageNumber),
});
type Position = typeof Position.Type;
const decodePosition = Schema.decodeUnknownOption(Schema.fromJsonString(Position));
const encodeCursor = (position: Position) =>
  Buffer.from(JSON.stringify(position), "utf8").toString("base64url");

const readError = (
  operation: IssueReadError["operation"],
  code: IssueReadError["code"],
  message: string,
  retryAt?: number,
) =>
  new IssueReadError({
    code,
    operation,
    message,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

const actor = (value: IssueActor) => ({
  login: value.login,
  avatarUrl:
    value.avatarUrl !== null && /^https?:\/\/\S+$/iu.test(value.avatarUrl) ? value.avatarUrl : null,
});

/** One upstream row with the fork's facts for it: relationships, milestone, projects. */
const roadmapRow = (
  issue: IssueSummary,
  number: number,
  facts: ReturnType<ListMetadata["get"]>,
  milestones: ReadonlyMap<number, IssueMilestone>,
): RepositoryIssueSummary => {
  const { milestone, ...overlay } = facts ?? {};
  return {
    number,
    title: issue.title,
    url: issue.url,
    state: issue.state.category,
    // GitHub's REST spelling, which the work states and the done details read.
    stateReason: issue.state.closeReason?.replaceAll("-", "_") ?? null,
    planningStatus: issue.state.name,
    author: issue.author === null ? null : actor(issue.author),
    assignees: issue.assignees.map(actor),
    labels: issue.labels.map((label) => ({
      name: label.name,
      color: label.color !== null && /^[0-9a-f]{6}$/iu.test(label.color) ? label.color : null,
    })),
    milestone: milestone == null ? null : (milestones.get(milestone.number) ?? milestone),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    commentCount: issue.commentCount,
    projects: [],
    ...overlay,
  };
};

/** Issue rows with their relationships, milestones and live work. */
export class IssueRoadmap extends Context.Service<
  IssueRoadmap,
  {
    readonly list: (
      input: RepositoryIssueListInput,
    ) => Effect.Effect<RepositoryIssueListResult, IssueReadError>;
    /** The issue with the same overlay its list row carries. */
    readonly detail: (input: IssueDetailInput) => Effect.Effect<IssueDetailResult, IssueReadError>;
    readonly statusBatch: (
      input: IssueStatusBatchInput,
    ) => Effect.Effect<IssueStatusBatchResult, IssueReadError>;
  }
>()("t3/issues/IssueRoadmap") {}

export const layer = Layer.effect(
  IssueRoadmap,
  Effect.gen(function* () {
    const trackerIssues = yield* TrackerIssueService.IssueService;
    const issues = yield* IssueService.IssueService;
    const links = yield* IssueLinks.IssueLinks;
    const sql = yield* SqlClient.SqlClient;
    const withLiveWork = (list: RepositoryIssueListResult) =>
      links.enrich(list).pipe(
        Effect.orElseSucceed(() => ({
          ...list,
          issues: list.issues.map(({ pullRequestRefs: _refs, ...issue }) => ({
            ...issue,
            liveWork: [],
          })),
        })),
      );

    const overlayOf = (
      input: IssueRepositoryRef & { readonly refresh?: boolean | undefined },
      numbers: ReadonlyArray<number>,
    ) =>
      issues.overlay({ ...input, numbers }).pipe(
        Effect.map((read) => ({
          complete: Option.isSome(read),
          facts: Option.getOrElse(
            read,
            (): ListMetadata =>
              new Map(numbers.map((number) => [number, { relationshipsComplete: false }])),
          ),
        })),
      );

    const readRows = Effect.fn("IssueRoadmap.readRows")(function* (
      input: IssueRepositoryRef & {
        readonly state: "open" | "all";
        readonly refresh?: boolean | undefined;
      },
      position: Position | null,
    ) {
      yield* trackerIssueRef(trackerIssues, "list", input);
      const issuePage = position === null ? 1 : position.issues;
      const milestonePage = position === null ? 1 : position.milestones;
      const [page, milestones] = yield* Effect.all(
        [
          issuePage === null
            ? Effect.succeed({ items: [], nextPage: null })
            : issues.repositoryIssuesPage({ ...input, page: issuePage }),
          milestonePage === null
            ? Effect.succeed({ items: [], nextPage: null })
            : issues.milestones({ ...input, page: milestonePage }),
        ],
        { concurrency: "unbounded" },
      );
      const overlay = yield* overlayOf(
        input,
        page.items.map(({ number }) => number),
      );
      const milestonesByNumber = new Map(
        milestones.items.map((milestone) => [milestone.number, milestone]),
      );
      const next: Position = {
        issues: page.nextPage,
        milestones: milestones.nextPage,
      };
      return {
        complete: overlay.complete,
        list: {
          repository: { host: input.host, repository: input.repository },
          viewer: null,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
          issues: page.items.map((issue) => {
            const { milestone = issue.milestone, ...facts } = overlay.facts.get(issue.number) ?? {};
            return {
              ...issue,
              ...facts,
              milestone:
                milestone == null ? null : (milestonesByNumber.get(milestone.number) ?? milestone),
            };
          }),
          milestones: milestones.items,
          nextCursor: next.issues === null && next.milestones === null ? null : encodeCursor(next),
          issuesComplete: next.issues === null,
          milestonesComplete: next.milestones === null,
        } satisfies RepositoryIssueListResult,
      };
    });

    const readDetail = Effect.fn("IssueRoadmap.readDetail")(function* (input: IssueDetailInput) {
      const ref = yield* trackerIssues
        .resolveUrl(`https://${input.host}/${input.repository}/issues/${input.number}`)
        .pipe(Effect.mapError(fromTrackerError("detail")));
      const detail = yield* trackerIssues
        .detail(ref)
        .pipe(Effect.mapError(fromTrackerError("detail")));
      const overlay = yield* overlayOf(input, [input.number]);
      return {
        complete: overlay.complete,
        list: {
          repository: { host: input.host, repository: input.repository },
          viewer: null,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
          issues: [roadmapRow(detail, input.number, overlay.facts.get(input.number), new Map())],
          milestones: [],
          nextCursor: null,
          issuesComplete: true,
          milestonesComplete: true,
        } satisfies RepositoryIssueListResult,
        linkedPullRequests: detail.linkedPullRequests.map(
          ({ repository, number, title, state, isDraft, url, closesIssue }) => ({
            repository,
            number,
            title,
            state,
            isDraft,
            url,
            closesIssue,
          }),
        ),
      };
    });
    const ttl = (read: { readonly complete: boolean }) =>
      read.complete ? ROWS_MAX_AGE_MS : INCOMPLETE_ROWS_MAX_AGE_MS;
    const rowsCache =
      IssueService.makeLiveReadCache<Effect.Success<ReturnType<typeof readRows>>>(ttl);
    const detailCache =
      IssueService.makeLiveReadCache<Effect.Success<ReturnType<typeof readDetail>>>(ttl);

    return IssueRoadmap.of({
      statusBatch: Effect.fn("IssueRoadmap.statusBatch")(function* (input) {
        const statuses = yield* issues.statusBatch(input);
        const repositories = new Map<string, (typeof statuses)[number][]>();
        for (const status of statuses) {
          const key = `${status.host.toLowerCase()}/${status.repository.toLowerCase()}`;
          const group = repositories.get(key) ?? [];
          group.push(status);
          repositories.set(key, group);
        }
        const lists = Array.from(repositories.values(), (group) => ({
          repository: { host: group[0]!.host, repository: group[0]!.repository },
          issues: group.map((status) => ({ ...status, pullRequestRefs: status.pullRequests })),
        }));
        const enriched = yield* sql
          .withTransaction(
            Effect.forEach(lists, (list) =>
              links.enrich(list).pipe(Effect.orElseSucceed(() => list)),
            ),
          )
          .pipe(
            NodeSqliteClient.readOnly,
            Effect.orElseSucceed(() => lists),
          );
        const result: Array<IssueStatusBatchResult[number]> = [];
        for (const list of enriched) {
          for (const status of list.issues) {
            const compactPr = ({
              host,
              repository,
              number,
              url,
              state,
              updatedAt,
            }: (typeof status.pullRequests)[number]) => ({
              host,
              repository,
              number,
              ...(url === undefined ? {} : { url }),
              state,
              updatedAt,
            });
            result.push({
              host: status.host,
              nodeId: status.nodeId,
              suspensionReason: status.suspensionReason,
              state: status.state,
              stateReason: status.stateReason,
              blockedBy: status.blockedBy,
              pullRequests: status.pullRequests.map(compactPr),
              closingPullRequests: (status.closingPullRequests ?? status.pullRequests).map(
                compactPr,
              ),
              liveWork: status.liveWork?.map(
                ({
                  threadId,
                  inherited,
                  status,
                  paused,
                  requestHandledByParent,
                  pullRequests = [],
                }) => ({
                  threadId,
                  inherited,
                  status,
                  ...(paused === true ? { paused } : {}),
                  ...(requestHandledByParent ? { requestHandledByParent } : {}),
                  ...(pullRequests.length === 0 ? {} : { pullRequests }),
                }),
              ),
            });
          }
        }
        return result;
      }),
      list: Effect.fn("IssueRoadmap.list")(function* (input) {
        const state = input.state ?? "open";
        const position =
          input.cursor === undefined
            ? null
            : Option.getOrNull(
                decodePosition(Buffer.from(input.cursor, "base64url").toString("utf8")),
              );
        if (input.cursor !== undefined && position === null)
          return yield* readError(
            "list",
            "invalid-cursor",
            "The issue cursor is invalid for this repository.",
          );
        const key = `${input.host.toLowerCase()} ${input.repository.toLowerCase()} ${state} ${input.cursor ?? ""}`;
        const revision = yield* issues.revision(input);
        const read = yield* rowsCache(
          key,
          readRows({ ...input, state }, position),
          input.refresh,
          revision,
        );
        return yield* withLiveWork(read.list);
      }),
      detail: Effect.fn("IssueRoadmap.detail")(function* (input) {
        const key = `${input.host.toLowerCase()} ${input.repository.toLowerCase()} ${input.number}`;
        const revision = yield* issues.revision(input);
        const read = yield* detailCache(key, readDetail(input), input.refresh, revision);
        const enriched = yield* links.enrich(read.list).pipe(Effect.orElseSucceed(() => read.list));
        return {
          repository: read.list.repository,
          viewer: null,
          fetchedAt: read.list.fetchedAt,
          issue: enriched.issues[0]!,
          linkedPullRequests: read.linkedPullRequests,
        };
      }),
    });
  }),
);
