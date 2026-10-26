import {
  LIVE_ISSUE_REFRESH_MS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type IssueDetailInput,
  type IssueListInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { request, type EnvironmentRpcInput } from "../rpc/client.ts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createPullRequestRefreshAtomFamily } from "./pullRequests.ts";
import {
  environmentRpcKey,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** An open issue's fallback re-read when none of its own threads finish a turn. */
const DETAIL_POLL_MS = 5 * 60_000;

/** Issue reads run on the environment whose GitHub credential the user selected. */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const liveQuery = <
    TTag extends
      | typeof WS_METHODS.issuesList
      | typeof WS_METHODS.issuesDetail
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
        execute: (input, emit) =>
          Effect.suspend(() => {
            const refresh = explicitRefresh || input.refresh === true;
            explicitRefresh = false;
            return options.execute({ ...input, refresh }, emit);
          }),
      })(target);
      const exposed = Atom.family((view: typeof source) =>
        Atom.readable(
          (get) => get(view),
          (refresh) => {
            explicitRefresh = true;
            refresh(view);
          },
        ).pipe(Atom.setIdleTTL(0)),
      );
      return { source, exposed };
    });
    return {
      query: (target: { environmentId: EnvironmentId; input: EnvironmentRpcInput<TTag> }) =>
        family(environmentRpcKey(target)).source,
      expose: (
        target: { environmentId: EnvironmentId; input: EnvironmentRpcInput<TTag> },
        view?: ReturnType<ReturnType<typeof createEnvironmentRpcQueryAtomFamily<R, E, TTag>>>,
      ) => {
        const state = family(environmentRpcKey(target));
        return state.exposed(view ?? state.source);
      },
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
  const linkRefreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:link-refreshes",
    tag: WS_METHODS.issuesSubscribeLinkRefreshes,
  });
  const localChanges = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const linkSignals = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      [
        Option.getOrElse(
          AsyncResult.value(get(linkRefreshes({ environmentId, input: {} }))),
          () => 0,
        ),
        get(localChanges(environmentId)),
      ].join(":"),
    ),
  );
  const linkRefreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    linkSignals(environmentId);
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
  const detail = liveQuery({
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    execute: (input) => request(WS_METHODS.issuesDetail, input),
    staleTimeMs: 60_000,
    refreshIntervalMs: DETAIL_POLL_MS,
    refreshTrigger: linkRefreshTrigger,
  });
  // The PR refresh stream has no thread identity; shell completions let each issue filter locally.
  const liveDetail = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, IssueDetailInput];
    const source = detail.query({ environmentId, input });
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
  const listQuery = liveQuery({
    label: "environment-data:issues:list",
    tag: WS_METHODS.issuesList,
    execute: (input) => request(WS_METHODS.issuesList, input),
    staleTimeMs: LIVE_ISSUE_REFRESH_MS,
    refreshTrigger: linkRefreshTrigger,
  });
  const listTarget = ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: IssueListInput;
  }) => ({
    environmentId,
    input: {
      host: input.host.toLowerCase(),
      repository: input.repository.toLowerCase(),
      state: input.state ?? "open",
      roadmap: input.roadmap ?? false,
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
  });
  const list = (target: Parameters<typeof listTarget>[0]) => listQuery.query(listTarget(target));
  // All visible first-page consumers share one poll and one underlying list request.
  const polledLists = Atom.family((source: ReturnType<typeof list>) =>
    Atom.transform(
      source,
      (get) => {
        const result = get(source);
        if (!result.waiting) {
          // @effect-diagnostics-next-line globalTimers:off -- Scoped to the mounted live list.
          const timer = setTimeout(() => get.refresh(source), LIVE_ISSUE_REFRESH_MS);
          get.addFinalizer(() => clearTimeout(timer));
        }
        return result;
      },
      { initialValueTarget: source },
    ).pipe(Atom.setIdleTTL(0)),
  );
  const liveList = (target: Parameters<typeof list>[0]) =>
    listQuery.expose(listTarget(target), polledLists(list(target)));
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
    list: (target: Parameters<typeof list>[0]) =>
      listQuery.expose(listTarget(target), list(target)),
    liveList,
    roadmapList: liveList,
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
    detail: (target: Parameters<typeof detail.query>[0]) =>
      detail.expose(target, liveDetail(environmentRpcKey(target))),
  };
}
