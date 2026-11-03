import { services as gitHubServices } from "@t3tools/source-control-github/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
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
  // The git-bug host finds opted-in checkouts among the projects (IssueGitBugHost.discover).
  // The resolver is the server's own (passed through, so it is required), not a second cache.
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProcessRunner.layer,
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        Effect.service(RepositoryIdentityResolver.RepositoryIdentityResolver),
      ),
    ),
  ),
);

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
