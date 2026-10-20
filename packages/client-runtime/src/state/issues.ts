import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type IssueDetailInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createPullRequestRefreshAtomFamily } from "./pullRequests.ts";
import {
  environmentRpcKey,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** How often an issue someone is looking at re-reads GitHub, besides explicit refreshes. */
const LIVE_ISSUE_REFRESH_MS = 60_000;
/** An open issue's fallback re-read when none of its own threads finish a turn. */
const DETAIL_POLL_MS = 5 * 60_000;

/** Issue reads run on the environment whose GitHub credential the user selected. */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
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
  const linkRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:link-refreshes",
    tag: WS_METHODS.issuesSubscribeLinkRefreshes,
  });
  const localChanges = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const linkRefreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    Atom.make((get) => [
      get(linkRefreshes({ environmentId, input: {} })),
      get(localChanges(environmentId)),
    ]);
  const changeRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:change-refreshes",
    tag: WS_METHODS.issueChangesSubscribe,
  });
  /** Unread inbox counts per repository orchestrator, re-sent on every inbox change. */
  const inboxUnread = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:inbox-unread",
    tag: WS_METHODS.issuesInboxSubscribeUnread,
  });
  // The slow poll picks up changes made outside T3, such as comments on GitHub; linked turns
  // below refresh sooner, at most once a minute.
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 60_000,
    refreshIntervalMs: DETAIL_POLL_MS,
    refreshTrigger: linkRefreshTrigger,
  });
  // The PR refresh stream has no thread identity; shell completions let each issue filter locally.
  const liveDetail = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, IssueDetailInput];
    const source = detail({ environmentId, input });
    const snapshot = snapshotAtom(environmentId);
    return Atom.transform(
      source,
      (get) => {
        let previous = get.once(snapshot);
        let lastRefresh = -Infinity;
        let trailing: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
          trailing = undefined;
          // @effect-diagnostics-next-line globalDate:off - Atom refresh scheduling uses the client clock.
          lastRefresh = Date.now();
          get.refresh(source);
        };
        get.addFinalizer(() => clearTimeout(trailing));
        get.subscribe(source, (result) => {
          // Any fresh read (poll, explicit refresh) satisfies a pending trailing refresh.
          if (AsyncResult.isSuccess(result) && !result.waiting) {
            clearTimeout(trailing);
            trailing = undefined;
          }
          get.setSelf(result);
        });
        get.subscribe(snapshot, (current) => {
          const before = previous;
          previous = current;
          if (before === null || current === null) return;
          const result = Option.getOrNull(AsyncResult.value(get.once(source)));
          const workers = new Set(result?.issue.liveWork?.map((work) => work.threadId));
          const runs = new Map(
            before.threads
              .filter((thread) => thread.latestRunCompletedAt != null)
              .map((thread) => [thread.id, thread.latestRunId]),
          );
          const finished = current.threads.some((thread) => {
            if (thread.latestRunCompletedAt == null || runs.get(thread.id) === thread.latestRunId)
              return false;
            const issue = thread.linkedIssue;
            return (
              workers.has(thread.id) ||
              (issue !== undefined &&
                issue.host.toLowerCase() === input.host.toLowerCase() &&
                issue.repository.toLowerCase() === input.repository.toLowerCase() &&
                issue.number === input.number)
            );
          });
          if (!finished || trailing !== undefined) return;
          // @effect-diagnostics-next-line globalDate:off - Atom refresh scheduling uses the client clock.
          const remaining = LIVE_ISSUE_REFRESH_MS - (Date.now() - lastRefresh);
          if (remaining <= 0) refresh();
          // @effect-diagnostics-next-line globalTimers:off - Scoped to this mounted detail atom.
          else trailing = setTimeout(refresh, remaining);
        });
        return get.once(source);
      },
      { initialValueTarget: source },
    ).pipe(Atom.setIdleTTL(0));
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
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
    }),
    cleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:cleanup",
      tag: WS_METHODS.issuesCleanup,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:unlink",
      tag: WS_METHODS.issuesUnlink,
    }),
    decideChange: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:decide-change",
      tag: WS_METHODS.issueChangesDecide,
    }),
    queueIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:queue",
      tag: WS_METHODS.issuesQueue,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
    }),
    unqueueIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:unqueue",
      tag: WS_METHODS.issuesUnqueue,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
    }),
    repositoryStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:repository-status",
      tag: WS_METHODS.issuesRepositoryStatus,
      staleTimeMs: 5_000,
      refreshIntervalMs: 5_000,
      refreshTrigger: linkRefreshTrigger,
    }),
    workMilestone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:milestone",
      tag: WS_METHODS.issuesWorkMilestone,
    }),
    setWorkerLimit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:worker-limit",
      tag: WS_METHODS.issuesSetWorkerLimit,
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
      refreshTrigger: linkRefreshTrigger,
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
      refreshTrigger: linkRefreshTrigger,
    }),
    /** Roadmap page one observes link changes without re-reading after agent turns. */
    roadmapList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:roadmap-list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
      refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
      refreshTrigger: linkRefreshTrigger,
    }),
    statusBatch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:status-batch",
      tag: WS_METHODS.issuesStatusBatch,
      // Retired sidebar sets must stop polling as soon as their last row unsubscribes.
      idleTtlMs: 0,
      staleTimeMs: LIVE_ISSUE_REFRESH_MS,
      refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
      refreshTrigger: (target) =>
        Atom.make((get) => [get(refreshTrigger(target)), get(linkRefreshTrigger(target))]),
    }),
    detail: (target: Parameters<typeof detail>[0]) => liveDetail(environmentRpcKey(target)),
  };
}
