import {
  type IssueDetailInput,
  type IssueDetailResult,
  type IssueReadError,
  type IssueListInput,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IssueService from "./IssueService.ts";
import * as IssueLinks from "./IssueLinks.ts";

/** Combines the GitHub list and local work in one existing RPC and refresh cadence. */
export class IssueRoadmap extends Context.Service<
  IssueRoadmap,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueReadError>;
    /** The issue with the same local work its list row carries. */
    readonly detail: (input: IssueDetailInput) => Effect.Effect<IssueDetailResult, IssueReadError>;
  }
>()("t3/issues/IssueRoadmap") {}

export const layer = Layer.effect(
  IssueRoadmap,
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const links = yield* IssueLinks.IssueLinks;
    return IssueRoadmap.of({
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
