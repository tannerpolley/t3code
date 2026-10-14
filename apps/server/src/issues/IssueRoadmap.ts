import { type IssueReadError, type IssueListInput, type IssueListResult } from "@t3tools/contracts";
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
    });
  }),
);
