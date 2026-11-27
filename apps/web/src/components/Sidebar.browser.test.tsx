import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import * as shelfHooks from "../state/olderSettledShelf";
import * as sidebarLayout from "../state/sidebarLayout";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EMPTY_SIDEBAR_LAYOUT,
  type SidebarLayoutRecord,
  type SidebarLayoutMutation,
  EnvironmentId,
  IssueTrackerKind,
  type LocalApi,
  ProjectId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import * as entities from "../state/entities";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import * as session from "../state/session";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { Sidebar as SidebarSurface, SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../state/sidebarLayout", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
    { key: "mod+shift+[", command: "thread.previous" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

// regression: #41549 a grouped project's folder New thread went to the primary copy
describe("sidebar project folder new thread", () => {
  it("starts in the copy of the viewed thread, as the new-thread shortcut does", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
    const primary = EnvironmentId.make("local");
    const dev1 = EnvironmentId.make("dev1");
    const repositoryIdentity = {
      canonicalKey: "github.com/acme/demo-repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/demo-repo.git",
      },
      displayName: "acme/demo-repo",
    };
    const primaryCopy = { ...project("demo-primary"), repositoryIdentity };
    const dev1Copy = {
      ...project("demo-dev1"),
      environmentId: dev1,
      repositoryIdentity,
    };
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(primary);
    vi.mocked(useConnectedEnvironmentIds).mockReturnValue([primary, dev1]);
    vi.mocked(useProjects).mockReturnValue([primaryCopy, dev1Copy]);
    const dev1Thread = makeThreadFixture({
      environmentId: dev1,
      id: ThreadId.make("dev1-thread"),
      projectId: dev1Copy.id,
      title: "dev1 work",
    });
    vi.mocked(useQuietThreadShells).mockReturnValue([dev1Thread]);
    const threadRef = scopeThreadRef(dev1, dev1Thread.id);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    const dev1ProjectRef = scopeProjectRef(dev1, dev1Copy.id);
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: dev1Thread,
      defaultProjectRef: dev1ProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: threadRef,
    });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "New thread in acme/demo-repo" }));

    expect(startThread).toHaveBeenCalledExactlyOnceWith(dev1ProjectRef);
  });
});

it("keeps a placed project row in keyboard order after sending, settling and remounting", async () => {
  using stack = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  using _operate = vi.spyOn(session, "useEnvironmentScope").mockReturnValue(false);
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });

  const web = project("web");
  const { environmentId, id: projectId } = web;
  const atDay = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
  const first = { ...threadShell(projectId, 1), createdAt: atDay(3) };
  const last = { ...threadShell(projectId, 2), createdAt: atDay(2) };
  const moved = { ...threadShell(projectId, 3), createdAt: atDay(1) };
  const ref = scopeThreadRef(environmentId, first.id);
  vi.mocked(useProjects).mockReturnValue([web]);
  vi.mocked(useQuietThreadShells).mockReturnValue([first, last, moved]);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: ref });
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([environmentId]);
  using _config = vi
    .spyOn(entities, "useServerConfigs")
    .mockReturnValue(
      new Map([
        [environmentId, { shellThreadFamilies: false } as unknown as EnvironmentServerConfig],
      ]),
    );
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: first,
    defaultProjectRef: scopeProjectRef(environmentId, projectId),
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: ref,
  });

  let record: SidebarLayoutRecord = {
    revision: 1,
    layout: {
      ...EMPTY_SIDEBAR_LAYOUT,
      sidebarProjectSections: [
        { id: "work", name: "Work", projectKeys: [projectId], collapsed: false },
      ],
    },
  };
  const change = vi.fn(async (_environmentId: EnvironmentId, mutation: SidebarLayoutMutation) => {
    if (mutation.type !== "placeThreads") throw new Error("Expected a thread placement");
    record = {
      revision: record.revision + 1,
      layout: { ...record.layout, threadRanks: mutation.ranks },
    };
    return true;
  });
  using _layout = vi.spyOn(sidebarLayout, "useSidebarLayout").mockImplementation(() => ({
    byEnvironment: new Map([[environmentId, { environmentId, record, writable: true }]]),
    change,
  }));
  const tree = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  const expected = [first, moved, last].map((thread) =>
    scopedThreadKey(scopeThreadRef(environmentId, thread.id)),
  );
  const checkPlacement = async (screen: Awaited<ReturnType<typeof render>>) => {
    const rows = Array.from(
      screen.container.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-folder"]'),
    );
    expect(rows.map((row) => row.dataset.sidebarRow)).toEqual(expected);
    rows[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
  };

  {
    await using screen = await render(tree());
    const row = (threadId: ThreadId) =>
      screen.container.querySelector<HTMLElement>(
        `[data-sidebar-row="${CSS.escape(scopedThreadKey(scopeThreadRef(environmentId, threadId)))}"]`,
      )!;
    const source = row(moved.id);
    const target = row(last.id);
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const x = sourceRect.x + sourceRect.width / 2;
    const sourceY = sourceRect.y + sourceRect.height / 2;
    const targetY = targetRect.y + targetRect.height / 2;
    const pointer = (type: string, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => source.dispatchEvent(pointer("pointerdown", sourceY)));
    await act(() => document.dispatchEvent(pointer("pointermove", sourceY - 10)));
    await act(() => document.dispatchEvent(pointer("pointermove", targetY)));
    await vi.waitFor(() =>
      expect(target.closest("li")?.style.transform).toMatch(/translate3d\(0px, [1-9]/),
    );
    await act(() => document.dispatchEvent(pointer("pointerup", targetY)));
    expect(change).toHaveBeenCalledExactlyOnceWith(environmentId, {
      type: "placeThreads",
      ranks: { [moved.id]: expect.any(String) },
    });
    await screen.rerender(tree());
    await checkPlacement(screen);
    const sent = {
      ...moved,
      latestUserAuthoredMessageAt: atDay(7),
      unsettledAt: atDay(7),
      activeOrderKey: "b",
    };
    vi.mocked(useQuietThreadShells).mockReturnValue([first, sent, last]);
    await screen.rerender(tree());
    await checkPlacement(screen);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      { ...sent, settledOverride: "settled", settledAt: atDay(8), activeOrderKey: null },
      first,
      last,
    ]);
    await screen.rerender(tree());
    await checkPlacement(screen);
  }
  record = JSON.parse(JSON.stringify(record));
  await using reloaded = await render(tree());
  await checkPlacement(reloaded);
});

it("lists child agents in role sections under their project and keeps a closed section closed", async () => {
  using stack = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    sidebarAgentTextSize: 18,
  });
  const ROLE_SECTIONS_KEY = "t3code:sidebar:role-sections-collapsed";
  localStorage.removeItem(ROLE_SECTIONS_KEY);
  stack.defer(() => localStorage.removeItem(ROLE_SECTIONS_KEY));

  const { environmentId, id: projectId, ...rest } = project("T3 Code");
  const parent = threadShell(projectId, 1);
  const root = {
    ...parent,
    title: "Compact sidebar threads",
    modelSelection: { ...parent.modelSelection, model: "gpt-6.2-astra" },
  };
  const time = root.createdAt;
  const run = {
    runId: RunId.make("task-run"),
    status: "completed" as const,
    requestedAt: time,
    startedAt: time,
    completedAt: time,
    assistantMessageId: null,
  };
  const child = {
    ...threadShell(projectId, 2),
    lineage: {
      rootThreadId: root.id,
      parentThreadId: root.id,
      relationshipToParent: "subagent" as const,
    },
    title: "Implement nested sidebar rows",
    delegatedRole: "implementation" as const,
    modelSelection: { ...root.modelSelection, model: "gpt-6.2-sol" },
    runtime: {
      status: "running" as const,
      activeRunId: run.runId,
      activityStartedAt: time,
      providerInstanceId: root.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: time,
    },
    pullRequests: [
      {
        host: "github.com",
        repository: "tannerpolley/t3code",
        number: 718,
        url: "https://github.com/tannerpolley/t3code/pull/718",
        source: "manual" as const,
        linkedAt: time,
        snapshot: {
          state: "open" as const,
          title: "Make sidebar rows compact",
          headBranch: "sidebar",
          baseBranch: "main",
          isDraft: false,
          updatedAt: time,
          syncedAt: time,
          checksState: "passing" as const,
        },
        stack: null,
      },
    ],
    issues: [
      {
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "tannerpolley/t3code",
        key: "709",
        displayKey: "#709",
        title: "Compact sidebar threads",
        url: "https://github.com/tannerpolley/t3code/issues/709",
        source: "manual" as const,
        linkedAt: time,
        projectId,
      },
    ],
  };
  const reviewer = {
    ...threadShell(projectId, 3),
    lineage: child.lineage,
    title: "Review compact sidebar",
    delegatedRole: "review" as const,
    modelSelection: { ...root.modelSelection, model: "claude-opus-5-5" },
    latestRun: run,
    lastVisitedAt: "2025-12-31T23:59:00.000Z",
  };
  const archived = {
    ...threadShell(projectId, 4),
    lineage: child.lineage,
    delegatedRole: "design" as const,
    archivedAt: time,
  };
  const owner = { ...threadShell(projectId, 5), title: "Release checklist" };
  const rootRef = scopeThreadRef(environmentId, root.id);
  vi.mocked(useProjects).mockReturnValue([{ ...rest, environmentId, id: projectId }]);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([environmentId]);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: rootRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: root,
    defaultProjectRef: scopeProjectRef(environmentId, projectId),
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: rootRef,
  });
  using _config = vi
    .spyOn(entities, "useServerConfigs")
    .mockReturnValue(
      new Map([
        [
          environmentId,
          { environment: { capabilities: {} } } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
  using _layout = vi.spyOn(sidebarLayout, "useSidebarLayout").mockReturnValue({
    byEnvironment: new Map([
      [
        environmentId,
        {
          environmentId,
          writable: true,
          record: {
            revision: 1,
            layout: {
              ...EMPTY_SIDEBAR_LAYOUT,
              sidebarProjectSections: [
                { id: "work", name: "In progress", projectKeys: [projectId], collapsed: false },
              ],
            },
          },
        },
      ],
    ]),
    change: vi.fn(),
  });

  const container = document.createElement("div");
  container.className = "bg-sidebar text-sidebar-foreground";
  container.style.width = "360px";
  container.style.height = "760px";
  container.style.marginInlineStart = "auto";
  const reveal = { observedKey: null, pendingKey: null };
  const tree = (key = "initial") => (
    <SidebarProvider key={key}>
      <SidebarSurface collapsible="none" className="h-[760px] w-full min-w-0">
        <Sidebar routeReveal={reveal} />
      </SidebarSurface>
    </SidebarProvider>
  );

  vi.mocked(useQuietThreadShells).mockReturnValue([child, reviewer, root, owner, archived]);
  await using screen = await render(tree(), { container });
  const parentRow = screen.getByRole("button", { name: /^Compact sidebar threads,/ });
  const implementor = screen.getByRole("button", {
    name: /^Implement nested sidebar rows, Working,/,
  });
  const doneReviewer = screen.getByRole("button", { name: /^Review compact sidebar, Done,/ });
  const implementors = screen.getByRole("button", { name: /^Implementors/ });
  const reviewers = screen.getByRole("button", { name: /^Reviewers/ });
  await expect.element(screen.getByText("In progress", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Release checklist", { exact: true })).toBeVisible();
  await expect.element(implementor).toBeVisible();
  await expect.element(doneReviewer).toBeVisible();
  await expect.element(implementors).toHaveTextContent("Implementors11 working");
  await expect.element(reviewers).toHaveTextContent("Reviewers1");
  // Archived children and empty roles stay out.
  await expect.element(screen.getByText("Designers", { exact: true })).not.toBeInTheDocument();
  // Children sit in their role section only, above the project's own threads.
  const item = (locator: { element: () => Element }) => locator.element().closest("li");
  expect(item(implementors)?.nextElementSibling).toBe(item(implementor));
  expect(item(implementor)?.nextElementSibling).toBe(item(reviewers));
  expect(item(reviewers)?.nextElementSibling).toBe(item(doneReviewer));
  expect(
    item(doneReviewer)!.compareDocumentPosition(item(parentRow)!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(implementor.element().getAttribute("data-sidebar-parent")).toBe(
    implementors.element().getAttribute("data-sidebar-row"),
  );
  await expect.element(parentRow.getByText("2 agents", { exact: true })).toBeVisible();
  await expect
    .element(parentRow.getByRole("button", { name: "2 child agents" }))
    .not.toBeInTheDocument();

  await implementors.click();
  await expect.element(implementors).toHaveAttribute("aria-expanded", "false");
  await expect.element(implementor).not.toBeInTheDocument();
  await screen.rerender(tree("remount"));
  await expect.element(implementors).toHaveAttribute("aria-expanded", "false");
  await expect.element(implementor).not.toBeInTheDocument();
  {
    using _timers = fakeTimers({ now: new Date(time) });
    await act(() => (implementors.element() as HTMLButtonElement).click());
    expect(implementor.getByText("0s", { exact: true }).element()).toBeVisible();
    vi.advanceTimersByTime(1000);
    expect(implementor.getByText("1s", { exact: true }).element()).toBeVisible();
  }
  const contentLeft = (element: Element) =>
    element.getBoundingClientRect().left +
    Number.parseFloat(getComputedStyle(element).paddingInlineStart);
  const projectTitle = screen.getByText("T3 Code", { exact: true }).element();
  // Rows start left of the project title, and a child agent sits deeper than its parent.
  expect(contentLeft(parentRow.element())).toBeLessThan(projectTitle.getBoundingClientRect().left);
  expect(contentLeft(implementor.element())).toBeGreaterThan(contentLeft(parentRow.element()));
  const titleLabel = implementor.getByText(child.title, { exact: true }).element();
  const row = implementor.element();
  const spinner = row.querySelector(".lucide-loader-circle")!;
  const model = implementor.getByText("Sol", { exact: true }).element();
  const version = implementor.getByText("6.2", { exact: true }).element();
  const issue = implementor.getByText("709", { exact: true }).element();
  const titleBox = titleLabel.getBoundingClientRect();
  expect(getComputedStyle(titleLabel).fontSize).toBe("18px");
  const boxes = [model, version, titleLabel, issue, spinner].map((element) =>
    element.getBoundingClientRect(),
  );
  for (const [index, box] of boxes.entries()) {
    expect(Math.abs(box.top + box.height / 2 - titleBox.top - titleBox.height / 2)).toBeLessThan(2);
    if (index > 0) expect(box.left).toBeGreaterThan(boxes[index - 1]!.left);
  }
  expect(getComputedStyle(spinner).animationTimingFunction).toBe("steps(8)");
  await vi.waitFor(() => expect(getComputedStyle(spinner).animationPlayState).toBe("running"));
  const rowItem = row.closest("li")!;
  rowItem.style.marginBlockStart = "200vh";
  await vi.waitFor(() => expect(getComputedStyle(spinner).animationPlayState).toBe("paused"));
  rowItem.style.removeProperty("margin-block-start");
  await expect.element(implementor.getByText("718", { exact: true })).not.toBeInTheDocument();
  expect(doneReviewer.element().querySelector(".bg-success")).toBeVisible();

  // A closed section still shows the open thread.
  await reviewers.click();
  await expect.element(doneReviewer).not.toBeInTheDocument();
  vi.mocked(useThreadRouteTarget).mockReturnValue({
    kind: "server",
    threadRef: scopeThreadRef(environmentId, reviewer.id),
  });
  await screen.rerender(tree("remount"));
  const openedReviewer = screen.getByRole("button", { name: /^Review compact sidebar,/ });
  await expect.element(openedReviewer).toHaveAttribute("aria-current", "page");
  expect(openedReviewer.element().querySelector(".bg-success")).toBeNull();
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: rootRef });
  await screen.rerender(tree("remount"));
  await expect.element(openedReviewer).not.toBeInTheDocument();

  const finished = { ...child, runtime: null, latestRun: run };
  vi.mocked(useQuietThreadShells).mockReturnValue([
    { ...finished, hasPendingUserInput: true },
    reviewer,
    root,
    owner,
    archived,
  ]);
  await screen.rerender(tree("remount"));
  await expect
    .element(screen.getByRole("button", { name: /^Implement nested sidebar rows, Input,/ }))
    .toBeVisible();
  await expect.element(implementors).toHaveTextContent("Implementors11 waiting on you");

  // A closed project sums up its threads and agents on one line.
  _layout.mockReturnValue({
    byEnvironment: new Map([
      [
        environmentId,
        {
          environmentId,
          writable: true,
          record: {
            revision: 2,
            layout: {
              ...EMPTY_SIDEBAR_LAYOUT,
              projectExpandedById: { [projectId]: false },
              sidebarProjectSections: [
                { id: "work", name: "In progress", projectKeys: [projectId], collapsed: false },
              ],
            },
          },
        },
      ],
    ]),
    change: vi.fn(),
  });
  await screen.rerender(tree("remount"));
  await expect.element(implementors).not.toBeInTheDocument();
  const folder = screen.getByRole("button", { name: /^T3 Code/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "false");
  await expect.element(folder.getByText("1 waiting", { exact: true })).toBeVisible();
});

// regression: #38623 unsent drafts are listed above threads but mod+1..9 skipped them
describe("sidebar numbered jumps", () => {
  it("numbers the unsent draft at the top before the threads below it", async () => {
    const initial = useComposerDraftStore.getState();
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.setState(initial, true));
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const web = project("web");
    vi.mocked(useProjects).mockReturnValue([web]);
    const thread = threadShell(web.id, 0);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    const draftId = DraftId.make("unsent-draft");
    initial.setProjectDraftThreadId(scopeProjectRef(web.environmentId, web.id), draftId, {
      threadId: ThreadId.make("unsent-draft-thread"),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    initial.setPrompt(draftId, "Unsent prompt");

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const draftRow = screen.getByTestId("sidebar-draft-row");
    await expect.element(draftRow).toBeInTheDocument();
    await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
    await userEvent.keyboard("{Control>}");
    await expect.element(screen.getByText("Ctrl+1")).toBeVisible();
    await expect.element(draftRow.getByText("Ctrl+1")).toBeVisible();
    await expect.element(screen.getByText("Ctrl+2")).toBeVisible();
    await userEvent.keyboard("{/Control}");

    // Previous thread from the open thread steps up to the draft above it.
    await userEvent.keyboard("{Control>}{Shift>}{BracketLeft}{/Shift}{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}2{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).not.toBe(`/draft/${draftId}`),
    );
    await userEvent.keyboard("{Control>}1{/Control}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/draft/${draftId}`),
    );
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread click", () => {
  // regression: #40715 macOS counts quick clicks on different rows, so the next row got detail 2 and was ignored
  it("opens another thread when the click arrives with a double-click count", async () => {
    const activeProject = project("active");
    const threads = [threadShell(activeProject.id, 0), threadShell(activeProject.id, 1)];
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: "/local/thread-0" },
    );
    const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);

    const openRow = screen.getByText("Thread 0").first().element();
    await act(() => {
      openRow.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();

    const row = screen.getByText("Thread 1").first().element();
    await act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
    });

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ threadId: "thread-1" }) }),
    );
  });
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: false });
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});
