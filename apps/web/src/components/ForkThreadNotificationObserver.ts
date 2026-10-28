import {
  ROUTED_REQUEST_ALERT_SETTLE_MS,
  runtimeRequestIsOwnerVisible,
  runtimeRequestOwnerAlertIsSettled,
} from "@t3tools/shared/delegatedRequestVisibility";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threadShell";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

export interface ForkNotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly parent: OrchestrationV2ThreadShell | undefined;
  readonly notifiedAttention: ReadonlySet<string> | null;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  readonly ownerVisibleSince: number | null;
}

export function createForkThreadNotificationObserver(
  environmentId: EnvironmentId,
  notify: (state: ForkNotificationState, kind: ThreadNotificationKind) => void,
  retract: (threadId: ThreadId) => void,
) {
  let previous = new Map<ThreadId, ForkNotificationState>();
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = createThreadNotificationGate<ThreadId>((threadId, kind) => {
    const state = previous.get(threadId);
    if (state) notify(state, kind);
  });
  const clear = () => {
    clearTimeout(timer);
    gate.clear();
    previous.clear();
    initialized = false;
  };
  const observe = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => {
    clearTimeout(timer);
    const next = new Map<ThreadId, ForkNotificationState>();
    const now = Date.now();
    let nextAlertDelay = Infinity;
    const index = new Map(threads.map((thread) => [thread.id, thread]));

    const subagentRequests = pendingSubagentRequestsByThread(
      threads.filter((thread) => thread.pendingRuntimeRequest?.routedTo === undefined),
    );
    const changed: Array<[ForkNotificationState | undefined, ForkNotificationState]> = [];
    for (const rawThread of threads) {
      const parent =
        rawThread.pendingRuntimeRequest?.routedTo === undefined
          ? undefined
          : index.get(rawThread.pendingRuntimeRequest.routedTo);
      const child = rawThread.lineage.relationshipToParent === "subagent";
      const prior = previous.get(rawThread.id);
      if (
        child &&
        rawThread.pendingRuntimeRequest?.routedTo === undefined &&
        rawThread.lineage.parentThreadId !== null &&
        index.has(rawThread.lineage.parentThreadId)
      ) {
        if (prior?.attention) retract(rawThread.id);
        continue;
      }
      const ownerVisible = runtimeRequestIsOwnerVisible(rawThread.pendingRuntimeRequest, parent);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      const request = rawThread.pendingRuntimeRequest;
      const ownerVisibleSince =
        ownerVisible && rawThread.archivedAt === null
          ? prior !== undefined &&
            prior.raw.pendingRuntimeRequest?.id === request?.id &&
            prior.ownerVisibleSince !== null
            ? prior.ownerVisibleSince
            : now
          : null;
      const unsettled =
        request !== null &&
        ownerVisibleSince !== null &&
        !runtimeRequestOwnerAlertIsSettled(request, ownerVisibleSince, now);
      if (unsettled)
        nextAlertDelay = Math.min(
          nextAlertDelay,
          ROUTED_REQUEST_ALERT_SETTLE_MS - (now - ownerVisibleSince),
        );
      // Parent activity can change attention even when the child object is unchanged.
      if (
        prior?.raw === rawThread &&
        prior.parent === parent &&
        prior.subagentRequest === subagentRequest &&
        (ownerVisibleSince === null ||
          request === null ||
          request.routedTo === undefined ||
          prior.attention !== null ||
          unsettled)
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest, parent);
      let status = resolveSidebarThreadStatus(thread);
      if (!child && status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        !unsettled &&
        (!child || ownerVisible) &&
        (status === "input" ||
          status === "request" ||
          status === "approval" ||
          (!child && (status === "failed" || status === "limited")))
          ? `${rawThread.pendingRuntimeRequest?.id ?? thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = !child && status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        parent,
        ownerVisibleSince,
        notifiedAttention:
          prior?.notifiedAttention ??
          (!initialized && child && unsettled && request !== null
            ? new Set([`${request.id}:${status}`])
            : null),
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
      };
      if (prior?.attention && attention !== prior.attention) {
        retract(thread.id);
      }
      if (child && attention !== null)
        state.notifiedAttention = new Set([...(prior?.notifiedAttention ?? []), attention]);
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    previous = next;
    gate.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      gate.observe(
        state.thread.id,
        prior,
        state.attention !== null && prior?.notifiedAttention?.has(state.attention) === true
          ? { ...state, attention: null }
          : state,
        {
          archived: state.thread.archivedAt !== null,
          quiet: state.raw.latestRunStopRequested === true,
        },
      );
    }
    initialized = true;
    if (nextAlertDelay !== Infinity) {
      timer = setTimeout(() => observe(threads), nextAlertDelay);
    }
  };
  return { observe, clear };
}
