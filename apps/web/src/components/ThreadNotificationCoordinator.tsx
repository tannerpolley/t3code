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
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  focusAppWindow,
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

// A click on a system notification can raise the window, and the focus it causes can
// arrive before the click itself. A notification closed in between drops the click.
const CLICK_AFTER_FOCUS_GRACE_MS = 1_000;

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  };
  const onRetract = (tag: string) => {
    const entry = pending.current.get(tag);
    if (!entry) return;
    entry.notification.close();
    pending.current.delete(tag);
    setNotificationBadge(pending.current.size);
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = (closeAfterMs?: number) => {
      const delivered = [...pending.current.values()];
      pending.current.clear();
      setNotificationBadge(0);
      const close = () => {
        for (const { notification } of delivered) notification.close();
      };
      if (closeAfterMs === undefined) close();
      else setTimeout(close, closeAfterMs);
    };
    const clearOnFocus = () => clear(CLICK_AFTER_FOCUS_GRACE_MS);
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clearOnFocus);
    window.addEventListener("focus", clearOnFocus);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clearOnFocus);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
      onRetract={onRetract}
    />
  ));
}

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly parent: OrchestrationV2ThreadShell | undefined;
  readonly notifiedAttention: ReadonlySet<string> | null;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  readonly ownerVisibleSince: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
  onRetract,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
  onRetract: (tag: string) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());
  const toasts = useRef(new Map<ThreadId, string>());
  const initialized = useRef(false);
  const [alertTime, setAlertTime] = useState(0);

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = useEffectEvent((threadId: ThreadId, kind: ThreadNotificationKind) => {
    const entry = previous.current.get(threadId);
    if (!entry) return;
    const { thread, status } = entry;
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
    ) {
      const toastId = toastManager.add({
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      toasts.current.set(thread.id, toastId);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
      });
      onNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        focusAppWindow();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  });
  const gate = useRef<ReturnType<typeof createThreadNotificationGate<ThreadId>>>(null);
  useEffect(() => {
    const created = createThreadNotificationGate<ThreadId>((threadId, kind) =>
      present(threadId, kind),
    );
    gate.current = created;
    return () => {
      created.clear();
      gate.current = null;
      // A new gate has no pending completions, so forget the states they compared against.
      previous.current.clear();
    };
  }, []);

  useEffect(() => {
    const pendingCompletions = gate.current;
    if (!pendingCompletions) return;
    if (threads === null) {
      pendingCompletions.clear();
      previous.current.clear();
      initialized.current = false;
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const now = Math.max(Date.now(), alertTime);
    let nextAlertDelay = Infinity;
    const index = new Map(threads.map((thread) => [thread.id, thread]));

    const subagentRequests = pendingSubagentRequestsByThread(
      threads.filter((thread) => thread.pendingRuntimeRequest?.routedTo === undefined),
    );
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      const parent =
        rawThread.pendingRuntimeRequest?.routedTo === undefined
          ? undefined
          : index.get(rawThread.pendingRuntimeRequest.routedTo);
      const child = rawThread.lineage.relationshipToParent === "subagent";
      if (
        child &&
        rawThread.pendingRuntimeRequest?.routedTo === undefined &&
        rawThread.lineage.parentThreadId !== null &&
        index.has(rawThread.lineage.parentThreadId)
      )
        continue;
      const ownerVisible = runtimeRequestIsOwnerVisible(rawThread.pendingRuntimeRequest, parent);
      const prior = previous.current.get(rawThread.id);
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
          (!initialized.current && child && unsettled && request !== null
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
        const toastId = toasts.current.get(thread.id);
        if (toastId !== undefined) toastManager.close(toastId);
        toasts.current.delete(thread.id);
        onRetract(threadNotificationTag(environmentId, thread.id));
      }
      if (child && attention !== null)
        state.notifiedAttention = new Set([...(prior?.notifiedAttention ?? []), attention]);
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    previous.current = next;
    pendingCompletions.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      pendingCompletions.observe(
        state.thread.id,
        prior,
        state.attention !== null && prior?.notifiedAttention?.has(state.attention) === true
          ? { ...state, attention: null }
          : state,
        {
          archived: state.thread.archivedAt !== null,
          quiet: state.raw.latestRunStopRequested === true || state.raw.latestRunSilent === true,
        },
      );
    }
    initialized.current = true;
    if (nextAlertDelay !== Infinity) {
      const timer = setTimeout(() => setAlertTime(Date.now()), nextAlertDelay);
      return () => clearTimeout(timer);
    }
  }, [environmentId, threads, alertTime, onRetract]);

  return null;
}
