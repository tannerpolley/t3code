import type { AnyRouter } from "@tanstack/react-router";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  settingsListeners: new Set<() => void>(),
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
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  delegatedChild: null as "running" | "approval" | null,
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

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
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

let stableParent: ReturnType<typeof mockThreadShell> | null = null;
function mockThreads() {
  if (state.delegatedChild === null) return [mockThreadShell()];
  stableParent ??= {
    ...mockThreadShell(),
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
  const child = {
    ...mockThreadShell(),
    id: "child-1",
    title: "Review the login form",
    creationSource: "mcp",
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest:
      state.delegatedChild === "approval"
        ? { id: "request-2", kind: "command", createdAt: SHELL_NOW }
        : state.input
          ? {
              id: "request-1",
              kind: "user_input",
              createdAt: SHELL_NOW,
              routedTo: "thread-1",
            }
          : null,
  };
  return [stableParent, child];
}

const shellAtom = Atom.make<unknown>(null);
const idsAtom = Atom.make(["env-1"]);
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => shellAtom) as never },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      get environmentIdsAtom() {
        return idsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

// The mocked modules read `state`, so every test starts by resetting all of it. The first
// render is left to the test because some tests change state before the coordinator mounts.
function setup() {
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
    subagent: false,
    background: [],
    delegatedChild: null,
  });
  stableParent = null;
  const stack = new AsyncDisposableStack();
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  state.settingsListeners.clear();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const router = {
    state: {
      get matches() {
        return [{ params: state.active }];
      },
    },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  let started = false;
  const renderCoordinator = async () => {
    registry.set(shellAtom, {
      status: state.live ? "live" : "disconnected",
      snapshot: Option.some({ threads: mockThreads() }),
    });
    if (!started) {
      stack.defer(startThreadNotifications(registry, router));
      started = true;
    }
    for (const listener of state.settingsListeners) listener();
  };
  return {
    render: renderCoordinator,
    complete: async () => {
      state.completedAt = "2026-09-13T10:00:00.000Z";
      await renderCoordinator();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("thread notifications", () => {
  it.each([true, false])(
    "retracts an owner-visible child alert after a shell refresh and an answer, focus=%s",
    async (focused) => {
      await using app = setup();
      state.subagent = true;
      state.focused = focused;
      state.mode = "notifications-and-sound";
      await app.render();
      state.input = true;
      await app.render();
      expect(state.sound).toHaveBeenCalledTimes(1);
      if (focused) expect(state.add).toHaveBeenCalledTimes(1);
      else expect(state.notification).toHaveBeenCalledTimes(1);
      await app.render();
      expect(state.sound).toHaveBeenCalledTimes(1);
      if (focused) expect(state.close).not.toHaveBeenCalled();
      else expect(state.notification.mock.results[0]?.value.close).not.toHaveBeenCalled();
      state.input = false;
      await app.render();
      if (focused) expect(state.close).toHaveBeenCalledWith("toast-1");
      else expect(state.notification.mock.results[0]?.value.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "keeps a routed child request silent while its parent works, focus=%s",
    async (focused) => {
      await using app = setup();
      state.subagent = true;
      state.delegatedChild = "running";
      state.focused = focused;
      state.mode = "notifications-and-sound";
      await app.render();
      state.input = true;
      await app.render();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    },
  );

  it("reveals the desktop window and opens the thread when a system alert is clicked", async () => {
    await using app = setup();
    const revealWindow = vi.fn(() => Promise.resolve());
    const showMainWindow = vi.fn(() => Promise.resolve());
    using _bridge = stubGlobal("desktopBridge", { revealWindow, showMainWindow });
    state.mode = "notifications";
    state.focused = false;
    await app.render();
    state.input = true;
    await app.render();
    const notification: EventTarget = state.notification.mock.results[0]?.value;
    notification.dispatchEvent(new Event("click"));
    expect(revealWindow).toHaveBeenCalledTimes(1);
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });
});
