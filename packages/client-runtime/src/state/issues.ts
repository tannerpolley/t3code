import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createPullRequestRefreshAtomFamily } from "./pullRequests.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  const changeRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:change-refreshes",
    tag: WS_METHODS.issueChangesSubscribe,
  });
  /** Unread inbox counts per repository orchestrator, re-sent on every inbox change. */
  const inboxUnread = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:inbox-unread",
    tag: WS_METHODS.issuesInboxSubscribeUnread,
  });
  return {
    inboxUnread,
    inbox: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:inbox",
      tag: WS_METHODS.issuesInboxList,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => inboxUnread({ environmentId, input: {} }),
    }),
    markInboxRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:inbox-mark-read",
      tag: WS_METHODS.issuesInboxMarkRead,
    }),
    changes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:changes",
      tag: WS_METHODS.issueChangesList,
      staleTimeMs: 60_000,
      refreshTrigger: (target) => changeRefreshes(target),
    }),
    decideChange: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:decide-change",
      tag: WS_METHODS.issueChangesDecide,
    }),
    repositoryStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:repository-status",
      tag: WS_METHODS.issuesRepositoryStatus,
      staleTimeMs: 5_000,
      refreshIntervalMs: 5_000,
      refreshTrigger,
    }),
    workMilestone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:milestone",
      tag: WS_METHODS.issuesWorkMilestone,
    }),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:pause",
      tag: WS_METHODS.issuesSetPaused,
    }),
    handoff: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:handoff",
      tag: WS_METHODS.issuesHandoff,
    }),
    /** Withdraws one unclaimed Start request so its root can be archived or replaced. */
    cancelRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:cancel-request",
      tag: WS_METHODS.issuesCancelRequest,
    }),
    /** Moves repository ownership from a stuck root to another top-level thread. */
    restoreRoot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:restore-root",
      tag: WS_METHODS.issuesRestoreRoot,
    }),
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
      refreshTrigger: (target) => (target.input.roadmap ? undefined : refreshTrigger(target)),
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
