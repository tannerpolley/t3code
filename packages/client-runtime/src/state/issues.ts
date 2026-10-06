import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createPullRequestRefreshAtomFamily } from "./pullRequests.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** How often an issue someone is looking at re-reads GitHub, besides after agent turns. */
const LIVE_ISSUE_REFRESH_MS = 60_000;

/** Issue reads run on the environment whose GitHub credential the user selected. */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    refreshes({ environmentId, input: {} });
  const workStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:work-status",
    tag: WS_METHODS.issuesWorkStatus,
    staleTimeMs: 5_000,
    refreshIntervalMs: 5_000,
    refreshTrigger,
  });
  return {
    workStatus,
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:start",
      tag: WS_METHODS.issuesStart,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { host, repository, number } = target.input;
          registry.refresh(
            workStatus({
              environmentId: target.environmentId,
              input: { host, repository, number },
            }),
          );
        }),
    }),
    repositories: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:repositories",
      tag: WS_METHODS.issuesRepositories,
      staleTimeMs: 5 * 60_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    /**
     * One repository's list shown beside a thread, kept live while agents work on its issues.
     * The Issues page reads many repositories through `list`, which stays unpolled.
     */
    liveList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:live-list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
      refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
      refreshTrigger,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:detail",
      tag: WS_METHODS.issuesDetail,
      staleTimeMs: 60_000,
      refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
      refreshTrigger,
    }),
  };
}
