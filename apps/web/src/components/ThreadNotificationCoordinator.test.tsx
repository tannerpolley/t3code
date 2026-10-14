import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shellReducer";
import type { ClientSettings } from "@t3tools/contracts/settings";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  shells: null as ReadonlyArray<OrchestrationV2ThreadShell> | null,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell(): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Fix the login form",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: state.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: RunId.make("run-1"),
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: RuntimeRequestId.make("request-1"), kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: RuntimeRequestId.make("request-1"), kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: state.shells ?? [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    shells: null,
    subagent: false,
    background: [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it.each([
    ["user_input", true],
    ["command", true],
    ["user_input", false],
    ["command", false],
  ] as const)(
    "alerts once for a routed %s request when only its parent changes, focused=%s",
    async (kind, focused) => {
      state.focused = focused;
      state.mode = "notifications-and-sound";
      state.subagent = true;
      const child = {
        ...mockThreadShell(),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-request"),
          kind,
          createdAt: SHELL_NOW,
          routedTo: ThreadId.make("parent"),
        },
      };
      const parent = {
        ...child,
        id: ThreadId.make("parent"),
        pendingRuntimeRequest: null,
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: null,
          relationshipToParent: null,
        },
      };
      state.shells = [parent, child];
      await render();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
      // The child object and request are untouched; the parent simply stops.
      state.shells = [{ ...parent, status: "interrupted" }, child];
      await render();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(2_999));
      expect(state.sound).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(1));
      await render();
      expect(state.sound).toHaveBeenCalledTimes(1);
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(1);
      const title = kind === "user_input" ? "Input needed" : "Approval needed";
      if (focused) expect(state.add.mock.calls[0]?.[0].title).toBe(title);
      else expect(state.notification.mock.calls[0]?.[0]).toBe(title);
      // Resuming and stopping cannot announce the same unanswered request twice.
      state.shells = [parent, child];
      await render();
      if (focused) expect(state.close).toHaveBeenCalledWith("toast-1");
      else expect(state.notification.mock.results[0]?.value.close).toHaveBeenCalledTimes(1);
      state.shells = [{ ...parent, status: "interrupted" }, child];
      await render();
      expect(state.sound).toHaveBeenCalledTimes(1);
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(1);
      // A newer request must not erase the identity of this still unanswered one.
      state.shells = [
        { ...parent, status: "interrupted" },
        {
          ...child,
          pendingRuntimeRequest: {
            ...child.pendingRuntimeRequest,
            id: RuntimeRequestId.make("second-child-request"),
          },
        },
      ];
      await render();
      await act(() => vi.advanceTimersByTime(3_000));
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(2);
      state.shells = [{ ...parent, status: "interrupted" }, child];
      await render();
      await act(() => vi.advanceTimersByTime(3_000));
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(2);
      expect(state.sound).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    "alerts for each new child request after idle and resolution, focused=%s",
    async (focused) => {
      state.focused = focused;
      state.mode = "notifications-and-sound";
      state.subagent = true;
      await render();
      state.input = true;
      await render();
      await render();
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(1);
      state.input = false;
      await render();
      state.shells = [
        {
          ...mockThreadShell(),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-2"),
            kind: "user_input",
            createdAt: SHELL_NOW,
          },
        },
      ];
      await render();
      await render();
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(2);
      expect(state.sound).toHaveBeenCalledTimes(2);
    },
  );

  it("alerts for a new child after the environment baseline, but not on its initial snapshot", async () => {
    state.subagent = true;
    state.input = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
    state.shells = [mockThreadShell(), { ...mockThreadShell(), id: ThreadId.make("new-child") }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "keeps a child arrival silent when transport delivers it before its parent, focused=%s",
    async (focused) => {
      state.focused = focused;
      state.mode = "notifications-and-sound";
      state.subagent = true;
      const child = mockThreadShell();
      const parent = {
        ...child,
        id: ThreadId.make("parent"),
        status: "completed" as const,
        activeRunId: null,
        activityRunStatus: null,
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: null,
          relationshipToParent: null,
        },
      };
      const baseline = {
        schemaVersion: 2,
        snapshotSequence: 0,
        projects: [],
        threads: [parent, child],
        archivedThreads: [],
      };
      state.shells = baseline.threads;
      await render();
      const pendingChild = {
        ...child,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("arrival"),
          kind: "user_input" as const,
          createdAt: SHELL_NOW,
          routedTo: parent.id,
        },
      };
      const intake = applyShellStreamEvent(baseline, {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: pendingChild,
      });
      state.shells = intake.threads;
      await render();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(1_000));
      state.shells = applyShellStreamEvent(intake, {
        kind: "thread.updated",
        sequence: 2,
        location: "active",
        thread: { ...parent, status: "queued" },
      }).threads;
      await render();
      await render();
      await act(() => vi.advanceTimersByTime(5_000));
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
      state.shells = [{ ...parent, status: "interrupted" }, pendingChild];
      await render();
      await act(() => vi.advanceTimersByTime(2_999));
      expect(state.sound).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(1));
      expect(focused ? state.add : state.notification).toHaveBeenCalledTimes(1);
      expect(state.sound).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])("keeps subagent progress silent with focus=%s", async (focused) => {
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it.each([true, false])(
    "takes back a question alert once the question is answered with focus=%s",
    async (focused) => {
      state.mode = "notifications";
      state.focused = focused;
      await render();
      state.input = true;
      await render();
      state.input = false;
      await render();
      if (focused) {
        expect(state.add).toHaveBeenCalledTimes(1);
        expect(state.close).toHaveBeenCalledWith("toast-1");
      } else {
        const notification = state.notification.mock.results[0]?.value as { close: () => void };
        expect(notification.close).toHaveBeenCalled();
      }
    },
  );

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("shows the desktop window, which may be hidden in the tray, when a system alert is clicked", async () => {
    const showMainWindow = vi.fn(async () => undefined);
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { focus: vi.fn(), desktopBridge: { showMainWindow } }),
    );
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    const notification = state.notification.mock.results[0]?.value as EventTarget;
    notification.dispatchEvent(new Event("click"));
    expect(showMainWindow).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });
});
