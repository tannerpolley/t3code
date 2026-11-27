import type { IssueListTarget } from "@t3tools/client-runtime/state/issues";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type IssueDetail,
  type IssueListResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { issuesSearchFromUrl } from "./issuesSearch.logic";

const selectedIssue = {
  who: "all",
  status: "open",
  selectedEnvironmentId: "env-1",
  selectedProjectId: "project-1",
  tracker: "github",
  scope: "owner/repo",
  key: "7",
} as const;
const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  useBoardFixture: false,
  move: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useNavigate: (() => {
      const navigate = actual.useNavigate();
      return state.useBoardFixture ? navigate : state.navigate;
    }) as never,
    useSearch: (() => {
      const search = actual.useRouterState({ select: ({ location }) => location.search });
      return state.useBoardFixture ? issuesSearchFromUrl(search) : selectedIssue;
    }) as never,
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "env-1",
        label: "Local",
        serverConfig: { environment: { capabilities: { issues: true } } },
      },
    ],
  })) as never,
  useIssuesSupported: () => true,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useProject: (ref) =>
    ref &&
    ({
      repositoryIdentity: {
        canonicalKey: `github.com/${repoScope(ref.projectId)}`,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://github.com/${repoScope(ref.projectId)}.git`,
        },
        provider: SourceControlProviderKind.make("github"),
        owner: "owner",
        name: repoScope(ref.projectId).split("/")[1],
        displayName: repoScope(ref.projectId),
      },
    } as ReturnType<typeof import("~/state/entities").useProject>),
  useServerConfigs: (() =>
    new Map([[environmentId, { environment: { capabilities: { issues: true } } }]])) as never,
}));
vi.mock(import("~/state/issues"), async (original) => {
  const actual = await original();
  const { useAtomValue } = await import("@effect/atom-react");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const moves = Atom.make<ReadonlyMap<string, IssueDetail["state"]>>(new Map());
  const pending = new Map<string, IssueDetail["state"]>();
  const details = Atom.family((key: string) =>
    Atom.make((get) => {
      const entry = enteredIssues.find((issue) => issue.key === key)!;
      return AsyncResult.success({
        ...entry,
        state: get(moves).get(key) ?? entry.state,
        states: workflow,
        writable: true,
        capabilities,
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        viewer: "octocat",
        body: "",
        comments: [],
        commentsCursor: null,
        events: [],
        linkedPullRequests: [],
      } satisfies IssueDetail);
    }),
  );
  const canWrite = Atom.make(true);
  const idle = () => {};
  return {
    ...actual,
    issueEnvironment: {
      ...actual.issueEnvironment,
      detail: (target, mountScope) =>
        state.useBoardFixture
          ? details(target.input.key)
          : actual.issueEnvironment.detail(target, mountScope),
      setState: {
        ...actual.issueEnvironment.setState,
        permissionAtom: () => canWrite,
        run: (_registry, target) =>
          Effect.sync(() => {
            state.move(target);
            pending.set(
              target.input.key,
              workflow.find((status) => status.name === target.input.state)!,
            );
          }),
      },
    },
    refreshIssueLists: () => {
      appAtomRegistry.set(moves, new Map(pending));
      pending.clear();
    },
    useIssueList: (targets: ReadonlyArray<IssueListTarget>) => {
      const current = useAtomValue(moves);
      const input = targets[0]?.input;
      const result: IssueListResult = {
        entries: enteredIssues
          .filter(
            (issue) =>
              !input?.labels?.length ||
              issue.labels.some(({ name }) => input.labels?.includes(name)),
          )
          .map((issue) => ({
            ...issue,
            projectId: input?.projectId ?? issue.projectId,
            scope: input?.scope ?? issue.scope,
            state: current.get(issue.key) ?? issue.state,
          })),
        trackers: [
          {
            tracker: github,
            host: "github.com",
            projectCount: 1,
            configured: true,
            capabilities,
            detail: null,
          },
        ],
        viewers: {},
        errors: [],
        nextCursors: {},
      };
      return {
        answers: state.useBoardFixture ? [[environmentId, result]] : [],
        isPending: false,
        error: null,
        refresh: idle,
        reload: idle,
        retry: idle,
      };
    },
  };
});

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ISSUES_PANEL_REF,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { IssuesPage } from "./IssuesPage";
import { RepoIssuesPanel } from "./RepoIssueBoard";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const repoScope = (id: ProjectId) => (id === projectId ? "owner/repo" : "owner/other");
const github = IssueTrackerKind.make("github");
const workflow = [
  { category: "open", name: "Backlog" },
  { category: "open", name: "In progress" },
  { category: "closed", name: "Done", closeReason: "completed" },
  { category: "open", name: "Todo" },
  { category: "open", name: "In review" },
] as const satisfies ReadonlyArray<IssueDetail["state"]>;
const capabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
};
const enteredIssues: IssueListResult["entries"] = [
  { key: "7", title: "Restore saved issue filters", state: workflow[0], label: "bug" },
  { key: "8", title: "Keep the active tab in view", state: workflow[0], label: "bug" },
  { key: "9", title: "Refresh issues when a tab opens", state: workflow[1], label: "bug" },
  { key: "10", title: "Update contributor docs", state: workflow[1], label: "docs" },
].map(({ key, title, state, label }) => ({
  projectId,
  projectTitle: "Code",
  tracker: github,
  host: "github.com",
  scope: "owner/repo",
  key,
  displayKey: `#${key}`,
  title,
  url: `https://github.com/owner/repo/issues/${key}`,
  author: { login: "octocat", name: null, avatarUrl: null },
  state,
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [{ name: label, color: "d73a4a" }],
  commentCount: 0,
}));

function setup() {
  state.navigate.mockReset();
  state.useBoardFixture = false;
  state.move.mockReset();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

const panelSurfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ISSUES_PANEL_REF).surfaces;

describe("IssuesPage shortcuts", () => {
  it("closes the active issue tab on the right panel close shortcut", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(<IssuesPage />);
    expect(panelSurfaces()).toHaveLength(1);

    await act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(panelSurfaces()).toEqual([]);
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith({ search: { who: "all", status: "open" } });
  });
});

describe("IssuesPage board", () => {
  it("switches between List and Board with the same issue filters", async () => {
    setup();
    state.useBoardFixture = true;
    const filters = { label: "bug", who: "assigned", status: "all", order: "created" };
    await using screen = await render(
      <AppAtomRegistryProvider>
        <IssuesPage />
      </AppAtomRegistryProvider>,
      { router: `/?${new URLSearchParams(filters)}` },
    );
    const issue = screen.getByRole("button", { name: /#7 Restore saved issue filters/ });
    await expect.element(issue).toBeVisible();
    await expect.element(screen.getByText("Update contributor docs")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("region", { name: "Backlog" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Board", exact: true }).click();
    const backlog = screen.getByRole("region", { name: "Backlog" });
    await expect.element(backlog.getByText("Restore saved issue filters")).toBeVisible();
    await expect.element(screen.getByText("Update contributor docs")).not.toBeInTheDocument();
    expect(screen.router?.state.location.search).toMatchObject({
      ...filters,
      label: ["bug"],
      view: "board",
    });
    await expect.element(screen.getByRole("region", { name: "Done" })).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Done" }).element().getBoundingClientRect().left,
    ).toBeGreaterThan(backlog.element().getBoundingClientRect().left);

    await screen.getByRole("button", { name: "List", exact: true }).click();
    await expect.element(backlog).not.toBeInTheDocument();
    await expect.element(issue).toBeVisible();
    await expect.element(screen.getByText("Update contributor docs")).not.toBeInTheDocument();
    expect(screen.router?.state.location.search).toMatchObject({ ...filters, label: ["bug"] });
    expect(screen.router?.state.location.search.view).toBeUndefined();
  });

  it("moves a card into an empty column and back through the move menu", async () => {
    setup();
    state.useBoardFixture = true;
    await page.viewport(1280, 720);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <IssuesPage />
      </AppAtomRegistryProvider>,
      { router: "/?view=board&status=all" },
    );
    const card = screen.getByRole("button", { name: /#7 Restore saved issue filters/ });
    const column = screen.getByRole("region", { name: "Done" });
    await expect.element(column).toBeVisible();
    await userEvent.dragAndDrop(card, column);

    await expect.element(column.getByText("Restore saved issue filters")).toBeVisible();
    expect(state.move).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        projectId,
        tracker: "github",
        host: "github.com",
        scope: "owner/repo",
        key: "7",
        state: "Done",
      },
    });
    await column.getByRole("button", { name: "Move issue #7" }).click();
    await page.getByRole("menuitem", { name: "Backlog" }).click();
    await expect
      .element(
        screen.getByRole("region", { name: "Backlog" }).getByText("Restore saved issue filters"),
      )
      .toBeVisible();
    expect(state.move).toHaveBeenCalledTimes(2);
  });
});

it("stacks the right-panel board and remembers each repository's collapsed groups", async () => {
  setup();
  state.useBoardFixture = true;
  const panel = (id: ProjectId) => (
    <AppAtomRegistryProvider>
      <div className="flex w-80">
        <RepoIssuesPanel
          threadRef={scopeThreadRef(environmentId, ThreadId.make("thread-1"))}
          projectId={id}
        />
      </div>
    </AppAtomRegistryProvider>
  );
  await using screen = await render(panel(projectId));
  const groups = ["Done", "In review", "In progress", "Todo", "Backlog"].map((name) =>
    screen.getByRole("region", { name, exact: true }),
  );
  const backlog = screen.getByRole("button", { name: "Backlog 2" });
  const progress = screen.getByRole("button", { name: "In progress 2" });
  const card = screen.getByText("Restore saved issue filters");
  await expect.element(groups[0]!).toBeVisible();
  const bounds = groups.map((group) => group.element().getBoundingClientRect());
  for (const [index, group] of bounds.slice(1).entries()) {
    expect(group.top).toBeGreaterThanOrEqual(bounds[index]!.bottom);
    expect(group.left).toBe(bounds[index]!.left);
  }
  await expect.element(backlog).toHaveAttribute("aria-expanded", "true");
  await expect.element(card).toBeVisible();
  await backlog.click();
  await expect.element(backlog).toHaveAttribute("aria-expanded", "false");
  await expect.element(card).not.toBeInTheDocument();
  await expect.element(progress).toHaveAttribute("aria-expanded", "true");

  await screen.rerender(panel(otherProjectId));
  await expect.element(backlog).toHaveAttribute("aria-expanded", "true");
  await expect.element(card).toBeVisible();
  await screen.rerender(panel(projectId));
  await expect.element(backlog).toHaveAttribute("aria-expanded", "false");
  await expect.element(card).not.toBeInTheDocument();
  await backlog.click();
  await expect.element(card).toBeVisible();
});
