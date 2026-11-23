import {
  LIVE_ISSUE_REFRESH_MS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type RepositoryIssueListInput,
  threadIssueKeyOf,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";

import { request, type EnvironmentRpcInput } from "../rpc/client.ts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createPullRequestRefreshAtomFamily } from "./pullRequests.ts";
import {
  environmentRpcKey,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The thread facts the server's live work per issue reads: links, claims, runs, requests,
 * background work, pull requests and worktrees. A change re-reads the roadmap's work overlay.
 */
function issueWorkSignal(snapshot: OrchestrationV2ShellSnapshot | null): string {
  if (snapshot === null) return "";
  return snapshot.threads
    .map((thread) =>
      [
        thread.id,
        thread.status,
        thread.activeRunId,
        thread.latestRunId,
        thread.pendingRuntimeRequest?.id,
        thread.pendingBackgroundTasks?.length,
        thread.linkedIssue === undefined
          ? ""
          : `${thread.linkedIssue.repository}#${thread.linkedIssue.number}`,
        thread.issues?.map(threadIssueKeyOf).join(","),
        thread.pullRequests?.map((pr) => pr.url).join(","),
        thread.branch,
        thread.worktreePath,
      ].join("|"),
    )
    .join("\n");
}

/** Issue reads run on the environment whose GitHub credential the user selected. */
export function createRepositoryIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const liveQuery = <
    TTag extends
      | typeof WS_METHODS.issueWorkRoadmap
      | typeof WS_METHODS.issueWorkDetail
      | typeof WS_METHODS.issuesStatusBatch,
  >(
    options: Parameters<typeof createEnvironmentRpcQueryAtomFamily<R, E, TTag>>[1] & {
      execute: NonNullable<
        Parameters<typeof createEnvironmentRpcQueryAtomFamily<R, E, TTag>>[1]["execute"]
      >;
    },
  ) => {
    const family = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [EnvironmentId, EnvironmentRpcInput<TTag>];
      const target = { environmentId, input };
      let explicitRefresh = false;
      const source = createEnvironmentRpcQueryAtomFamily(runtime, {
        ...options,
        execute: (input, emit, registry) =>
          Effect.suspend(() => {
            const refresh = explicitRefresh || input.refresh === true;
            explicitRefresh = false;
            return options.execute({ ...input, refresh }, emit, registry);
          }),
      })(target);
      // An explicit refresh, unlike a signal or mount, asks the server to read GitHub again.
      const exposed = Atom.readable(
        (get) => get(source),
        (refresh) => {
          explicitRefresh = true;
          refresh(source);
        },
      ).pipe(Atom.setIdleTTL(0));
      return { source, exposed };
    });
    return {
      query: (target: { environmentId: EnvironmentId; input: EnvironmentRpcInput<TTag> }) =>
        family(environmentRpcKey(target)).source,
      expose: (target: { environmentId: EnvironmentId; input: EnvironmentRpcInput<TTag> }) =>
        family(environmentRpcKey(target)).exposed,
    };
  };
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    refreshes({ environmentId, input: {} });
  const workStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:work-status",
    tag: WS_METHODS.issuesWorkStatus,
    staleTimeMs: 5_000,
    refreshIntervalMs: 5_000,
    refreshTrigger,
  });
  const localChanges = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const changeRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:change-refreshes",
    tag: WS_METHODS.issueChangesSubscribe,
  });
  /** Unread inbox counts per repository orchestrator, re-sent on every inbox change. */
  const inboxUnread = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:inbox-unread",
    tag: WS_METHODS.issuesInboxSubscribeUnread,
  });
  // The server re-sends unread counts, even unchanged, on issue writes, new GitHub activity and
  // queue or ownership changes. Its first value is the subscription starting, not activity.
  const inboxActivity = Atom.family((environmentId: EnvironmentId) => {
    let revision = -1;
    return Atom.make((get) => {
      if (AsyncResult.isSuccess(get(inboxUnread({ environmentId, input: {} })))) revision++;
      return Math.max(revision, 0);
    });
  });
  const workSignals = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => issueWorkSignal(get(snapshotAtom(environmentId)))),
  );
  // Thread shells carry runs and links; everything else arrives through the unread feed.
  const linkSignals = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      [
        get(workSignals(environmentId)),
        get(inboxActivity(environmentId)),
        get(localChanges(environmentId)),
      ].join("\n"),
    ),
  );
  const linkRefreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    linkSignals(environmentId);
  const detail = liveQuery({
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issueWorkDetail,
    execute: (input) => request(WS_METHODS.issueWorkDetail, input),
    staleTimeMs: 60_000,
    refreshTrigger: linkRefreshTrigger,
  });
  const listQuery = liveQuery({
    label: "environment-data:issues:list",
    tag: WS_METHODS.issueWorkRoadmap,
    execute: (input) => request(WS_METHODS.issueWorkRoadmap, input),
    staleTimeMs: LIVE_ISSUE_REFRESH_MS,
    refreshTrigger: linkRefreshTrigger,
  });
  const listTarget = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: RepositoryIssueListInput;
  }) => ({
    environmentId,
    input: {
      host: input.host.toLowerCase(),
      repository: input.repository.toLowerCase(),
      state: input.state ?? "open",
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
  });
  const repositoryStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:repository-status",
    tag: WS_METHODS.issuesRepositoryStatus,
    staleTimeMs: LIVE_ISSUE_REFRESH_MS,
    refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
    refreshTrigger: linkRefreshTrigger,
  });
  const statusBatch = liveQuery({
    label: "environment-data:issues:status-batch",
    tag: WS_METHODS.issuesStatusBatch,
    execute: (input) => request(WS_METHODS.issuesStatusBatch, input),
    // Retired sidebar sets must stop polling as soon as their last row unsubscribes.
    idleTtlMs: 0,
    staleTimeMs: LIVE_ISSUE_REFRESH_MS,
    refreshIntervalMs: LIVE_ISSUE_REFRESH_MS,
    refreshTrigger: linkRefreshTrigger,
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
    cleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:cleanup",
      tag: WS_METHODS.issuesCleanup,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
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
    repositoryStatus: ({ environmentId, input }: Parameters<typeof repositoryStatus>[0]) =>
      repositoryStatus({
        environmentId,
        input: { host: input.host.toLowerCase(), repository: input.repository.toLowerCase() },
      }),
    workMilestone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:milestone",
      tag: WS_METHODS.issuesWorkMilestone,
    }),
    setWorkerLimit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:worker-limit",
      tag: WS_METHODS.issuesSetWorkerLimit,
    }),
    setReadOnlyLimit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:read-only-limit",
      tag: WS_METHODS.issuesSetReadOnlyLimit,
    }),
    closeOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:close-out",
      tag: WS_METHODS.issuesCloseOut,
    }),
    endRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:end-repository",
      tag: WS_METHODS.issuesEndRepository,
    }),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:pause",
      tag: WS_METHODS.issuesSetPaused,
    }),
    assignOrchestrator: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:assign-orchestrator",
      tag: WS_METHODS.issuesAssignOrchestrator,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(localChanges(environmentId), (revision) => revision + 1)),
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
    list: (target: Parameters<typeof listTarget>[0]) => listQuery.expose(listTarget(target)),
    statusBatch: ({ environmentId, input }: Parameters<typeof statusBatch.query>[0]) => {
      const issues = new Map(
        input.issues.map(({ host, nodeId }) => {
          const ref = { host: host.toLowerCase(), nodeId };
          return [JSON.stringify(ref), ref] as const;
        }),
      );
      return statusBatch.expose({
        environmentId,
        input: {
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
          issues: [...issues.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, ref]) => ref),
        },
      });
    },
    detail: (target: Parameters<typeof detail.query>[0]) => detail.expose(target),
  };
}
