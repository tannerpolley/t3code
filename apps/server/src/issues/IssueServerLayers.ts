import { services as gitHubServices } from "@t3tools/source-control-github/server/driver";
import type {
  IssueCommentInput,
  IssueCreateInput,
  IssueScopeRef,
  IssueSetStateInput,
  IssueUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TrackerIssueService from "../issue/IssueService.ts";
import * as IssueCleanup from "./IssueCleanup.ts";
import * as IssueGitHubHost from "./IssueGitHubHost.ts";
import * as IssueLinks from "./IssueLinks.ts";
import * as IssueMergeClosing from "./IssueMergeClosing.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";
import * as IssueService from "./IssueService.ts";

// Issue reads verify the GitHub credential the same way pull request reads do, and share the
// GitHub quota and rate-limit pause (the built-in drivers' layer, memoized by reference) with them.
export const layerIssueService = IssueService.layer.pipe(
  Layer.provide(IssueGitHubHost.apiLayer),
  Layer.provide(gitHubServices),
);

/**
 * Upstream's issue writes, from the panel or an agent, change what the roadmap shows, so each
 * advances the fork's revision: cached rows are read again and clients are told.
 */
export const withRoadmapRevision = <E, R>(
  tracker: Layer.Layer<TrackerIssueService.IssueService, E, R>,
) =>
  Layer.effect(
    TrackerIssueService.IssueService,
    Effect.gen(function* () {
      const upstream = yield* TrackerIssueService.IssueService;
      const issues = yield* IssueService.IssueService;
      const changed = Effect.fn("RoadmapRevision.changed")(
        function* (ref: IssueScopeRef) {
          if (ref.tracker !== "github") return;
          const host = ref.host ?? (yield* upstream.projectScope(ref.projectId)).host;
          yield* issues.markChanged({ host, repository: ref.scope });
        },
        (effect) => Effect.ignore(effect),
      );
      return TrackerIssueService.IssueService.of({
        ...upstream,
        create: Effect.fn("RoadmapRevision.create")(function* (input: IssueCreateInput) {
          const created = yield* upstream.create(input);
          yield* changed(input);
          return created;
        }),
        comment: Effect.fn("RoadmapRevision.comment")(function* (input: IssueCommentInput) {
          yield* upstream.comment(input);
          yield* changed(input);
        }),
        update: Effect.fn("RoadmapRevision.update")(function* (input: IssueUpdateInput) {
          yield* upstream.update(input);
          yield* changed(input);
        }),
        setState: Effect.fn("RoadmapRevision.setState")(function* (input: IssueSetStateInput) {
          yield* upstream.setState(input);
          yield* changed(input);
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(tracker, layerIssueService)));

export const layerIssueMergeClosing = IssueMergeClosing.layer.pipe(
  Layer.provide(layerIssueService),
);

const layerIssueRoadmap = IssueRoadmap.layer.pipe(
  Layer.provideMerge(IssueLinks.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
  Layer.provideMerge(layerIssueService),
);
export const layerIssueRouterServices = Layer.mergeAll(
  layerIssueRoadmap,
  IssueCleanup.layer.pipe(
    Layer.provide(layerIssueRoadmap),
    Layer.provide(ProjectionStoreV2.layer),
    Layer.provide(ProjectStore.layer),
    Layer.provide(GitVcsDriver.layer),
  ),
);
