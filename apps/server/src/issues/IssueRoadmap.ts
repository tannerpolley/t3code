import {
  type IssueDetailInput,
  type IssueDetailResult,
  type IssueReadError,
  type IssueListInput,
  type IssueListResult,
  type IssueStatusBatchInput,
  type IssueStatusBatchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";

/** Combines the GitHub list and local work in one existing RPC and refresh cadence. */
export class IssueRoadmap extends Context.Service<
  IssueRoadmap,
  {
    readonly linkRefreshes: Stream.Stream<number>;
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueReadError>;
    /** The issue with the same local work its list row carries. */
    readonly detail: (input: IssueDetailInput) => Effect.Effect<IssueDetailResult, IssueReadError>;
    readonly statusBatch: (
      input: IssueStatusBatchInput,
    ) => Effect.Effect<IssueStatusBatchResult, IssueReadError>;
  }
>()("t3/issues/IssueRoadmap") {}

export const layer = Layer.effect(
  IssueRoadmap,
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const links = yield* IssueLinks.IssueLinks;
    return IssueRoadmap.of({
      linkRefreshes: links.refreshes,
      statusBatch: Effect.fn("IssueRoadmap.statusBatch")(function* (input) {
        const statuses = yield* issues.statusBatch(input);
        const repositories = new Map<string, (typeof statuses)[number][]>();
        for (const status of statuses) {
          const key = `${status.host.toLowerCase()}/${status.repository.toLowerCase()}`;
          const group = repositories.get(key) ?? [];
          group.push(status);
          repositories.set(key, group);
        }
        const result: Array<IssueStatusBatchResult[number]> = [];
        for (const group of repositories.values()) {
          const list = {
            repository: { host: group[0]!.host, repository: group[0]!.repository },
            issues: group.map((status) => ({ ...status, pullRequestRefs: status.pullRequests })),
          };
          const enriched = yield* links.enrich(list).pipe(Effect.orElseSucceed(() => list));
          for (const status of enriched.issues) {
            const compactPr = ({
              host,
              repository,
              number,
              state,
              updatedAt,
            }: (typeof status.pullRequests)[number]) => ({
              host,
              repository,
              number,
              state,
              updatedAt,
            });
            result.push({
              host: status.host,
              nodeId: status.nodeId,
              state: status.state,
              stateReason: status.stateReason,
              blockedBy: status.blockedBy,
              pullRequests: status.pullRequests.map(compactPr),
              closingPullRequests: (status.closingPullRequests ?? status.pullRequests).map(
                compactPr,
              ),
              liveWork: status.liveWork?.map(({ threadId, inherited, status }) => ({
                threadId,
                inherited,
                status,
              })),
            });
          }
        }
        return result;
      }),
      list: (input) =>
        issues.list(input).pipe(
          Effect.flatMap((list) =>
            input.roadmap !== true
              ? Effect.succeed(list)
              : links.enrich(list).pipe(
                  Effect.orElseSucceed(() => ({
                    ...list,
                    issues: list.issues.map(({ pullRequestRefs: _refs, ...issue }) => ({
                      ...issue,
                      liveWork: [],
                    })),
                  })),
                ),
          ),
        ),
      detail: (input) =>
        issues.detail(input).pipe(
          Effect.flatMap((detail) =>
            links
              .enrich({
                ...detail,
                milestones: [],
                nextCursor: null,
                issuesComplete: true,
                milestonesComplete: true,
                issues: [
                  {
                    ...detail.issue,
                    pullRequests: detail.linkedPullRequests
                      .filter((pr) => pr.closesIssue)
                      .map((pr) => ({ ...pr, host: detail.repository.host })),
                    // The list associates threads through closing pull requests; so does this.
                    pullRequestRefs: detail.linkedPullRequests
                      .filter((pr) => pr.closesIssue)
                      .map((pr) => ({
                        host: detail.repository.host,
                        repository: pr.repository,
                        number: pr.number,
                      })),
                  },
                ],
              })
              .pipe(
                Effect.map((list) => ({ ...detail, issue: list.issues[0] ?? detail.issue })),
                Effect.orElseSucceed(() => detail),
              ),
          ),
        ),
    });
  }),
);
