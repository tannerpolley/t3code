import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueReadError, ProjectId, type IssueListInput } from "@t3tools/contracts";

const harness = vi.hoisted(() => {
  const state = {
    search: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
    listRequests: [] as Array<{ environmentId: string; input: IssueListInput }>,
    projects: [] as ReadonlyArray<unknown>,
    environments: [] as ReadonlyArray<unknown>,
    resultFor: vi.fn(),
    openIssue: vi.fn(),
  };

  return {
    ...state,
    get search() {
      return state.search;
    },
    set search(value: Record<string, unknown>) {
      state.search = value;
    },
    navigate: vi.fn(
      (options: { search: (previous: Record<string, unknown>) => Record<string, unknown> }) => {
        state.search = options.search(state.search);
        for (const listener of state.listeners) listener();
      },
    ),
    panelState: { isOpen: false, activeSurfaceId: null, surfaces: [] },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => vi.fn(),
  useAtomValue: (atom: unknown) => {
    if (!atom || typeof atom !== "object" || !("input" in atom)) {
      return { _tag: "Initial", waiting: true };
    }
    return harness.resultFor((atom as { input: IssueListInput }).input);
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      options,
      fullPath: "/_chat/issues",
      useSearch: () => {
        const [, rerender] = React.useState(0);
        React.useEffect(() => {
          const listener = () => rerender((value) => value + 1);
          harness.listeners.add(listener);
          return () => {
            harness.listeners.delete(listener);
          };
        }, []);
        return harness.search;
      },
    }),
    useNavigate: () => harness.navigate,
  };
});

vi.mock("../components/issues/IssueDetailPanel", () => ({ IssueDetailPanel: () => null }));
vi.mock("../components/RightPanelTabs", () => ({ RightPanelTabs: () => null }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../panelAnimations", () => ({
  usePanelAnimationSettings: () => ({ active: false, durationMs: 0 }),
  usePanelPresence: () => ({ present: false, value: null }),
}));
vi.mock("../rightPanelStore", () => {
  const useRightPanelStore = Object.assign(
    (selector: (state: { byThreadKey: Record<string, never> }) => unknown) =>
      selector({ byThreadKey: {} }),
    {
      getState: () => ({
        openIssue: harness.openIssue,
        activateSurface: vi.fn(),
        closeSurface: vi.fn(),
        closeOtherSurfaces: vi.fn(),
        closeSurfacesToRight: vi.fn(),
        closeAllSurfaces: vi.fn(),
        close: vi.fn(),
      }),
    },
  );
  return {
    ISSUES_PANEL_REF: { threadId: "issues-panel" },
    issueSurface: (target: Record<string, unknown>) => ({
      ...target,
      id: `issue:${String(target.projectId)}:${String(target.number)}`,
      kind: "issue",
    }),
    selectActiveRightPanelSurface: () => null,
    selectSelectedRightPanelSurface: () => null,
    selectThreadRightPanelState: () => harness.panelState,
    useRightPanelStore,
  };
});
vi.mock("../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () => harness.projects,
  useThreadShell: () => null,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: harness.environments }),
}));
vi.mock("../state/issues", () => ({
  useIssueLists: (targets: Array<{ environmentId: string; input: IssueListInput }>) => {
    const answers: Array<{ target: (typeof targets)[number]; result: unknown; waiting: boolean }> =
      [];
    const failures: Array<{ target: (typeof targets)[number]; cause: unknown }> = [];
    for (const target of targets) {
      harness.listRequests.push(target);
      const result = harness.resultFor(target.input);
      if (result._tag === "Success") {
        answers.push({ target, result: result.value, waiting: result.waiting });
      } else if (result._tag === "Failure") {
        failures.push({ target, cause: result.cause });
      }
    }
    return {
      answers,
      failures,
      isPending: answers.some((answer) => answer.waiting),
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { input?: IssueListInput } | null) => {
    const result = atom?.input === undefined ? null : harness.resultFor(atom.input);
    return {
      data: result?._tag === "Success" ? result.value : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("../components/ui/button", async () => {
  const React = await import("react");
  return {
    Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
      const { children, ...rest } = props;
      return React.createElement("button", rest, children);
    },
  };
});
vi.mock("../components/ui/empty", async () => {
  const React = await import("react");
  const Box = (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { children, ...rest } = props;
    return React.createElement("div", rest, children);
  };
  return {
    Empty: Box,
    EmptyDescription: Box,
    EmptyHeader: Box,
    EmptyTitle: Box,
  };
});
vi.mock("../components/ui/sidebar", async () => {
  const React = await import("react");
  return {
    SidebarInset: (props: Record<string, unknown> & { children?: ReactNode }) => {
      const { children, ...rest } = props;
      return React.createElement("main", rest, children);
    },
  };
});
vi.mock("../components/ui/spinner", async () => {
  const React = await import("react");
  return { Spinner: (props: Record<string, unknown>) => React.createElement("span", props) };
});

import { Route } from "./_chat.issues";

const IssuesRoute = Route.options.component!;

const environmentId = EnvironmentId.make("issues-regression-environment");
const projectId = ProjectId.make("issues-regression-project");
const staleHost = "stale.example.test";
const staleRepository = "stale/wrong-repository";
const canonicalRepository = "acme/project";
const projectKey = `${environmentId}:${projectId}`;

const issue = {
  number: 7,
  title: "Canonical issue loaded after reselecting the project",
  url: "https://github.com/acme/project/issues/7",
  state: "open" as const,
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone: null,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  commentCount: 0,
};

const success = AsyncResult.success({
  repository: { projectId, host: "github.com", repository: canonicalRepository },
  projectTitle: "Canonical GitHub project",
  workspaceRoot: "/workspace/project",
  viewer: null,
  fetchedAt: "2026-09-21T00:00:00.000Z",
  issues: [issue],
  milestones: [],
  nextCursor: null,
  issuesComplete: true,
  milestonesComplete: true,
});

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? children.map(textContent).join("") : textContent(children);
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.search = {
    environmentId,
    projectId,
    host: staleHost,
    repository: staleRepository,
    number: issue.number,
  };
  harness.listeners.clear();
  harness.listRequests.length = 0;
  harness.projects = [
    {
      id: projectId,
      environmentId,
      title: "Canonical GitHub project",
      repositoryIdentity: {
        provider: "github",
        canonicalKey: `github.com/${canonicalRepository}`,
        displayName: canonicalRepository,
        owner: "acme",
        name: "project",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://github.com/${canonicalRepository}.git`,
        },
      },
    },
  ];
  harness.environments = [
    {
      environmentId,
      label: "Issues environment",
      serverConfig: { environment: { capabilities: { githubIssues: true } } },
    },
  ];
  harness.openIssue.mockClear();
  harness.resultFor.mockReset();
  const scopeUnavailable = new IssueReadError({
    code: "scope-unavailable",
    operation: "list",
    message: "The requested host and repository are outside this project's scope.",
  });
  harness.resultFor.mockImplementation((input: IssueListInput) =>
    input.host === staleHost || input.repository === staleRepository
      ? AsyncResult.failure(Cause.fail(scopeUnavailable))
      : success,
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("issues route project-scope recovery", () => {
  it("keeps explicit stale scope, lets the same project be reselected, and reloads canonically", async () => {
    await act(async () => {
      await IssuesRoute.preload?.();
      renderer = create(<IssuesRoute />);
    });

    expect(harness.listRequests[0]).toEqual({
      environmentId,
      input: { projectId, host: staleHost, repository: staleRepository },
    });
    expect(textContent(renderer!.root)).toContain("Project scope unavailable");

    const chooser = renderer!.root.findByProps({ "aria-label": "GitHub project" });
    expect(chooser.props.value).toBe("");
    expect(
      chooser
        .findAllByType("option")
        .some(
          (option) =>
            option.props.value === projectKey &&
            textContent(option).includes("Canonical GitHub project"),
        ),
    ).toBe(true);

    const requestCountBeforeReselect = harness.listRequests.length;
    await act(async () => {
      chooser.props.onChange({ target: { value: projectKey } });
    });

    expect(harness.search).toEqual({ environmentId, projectId });
    const followupRequests = harness.listRequests.slice(requestCountBeforeReselect);
    expect(followupRequests.length).toBeGreaterThan(0);
    expect(
      followupRequests.every(
        ({ input }) =>
          input.projectId === projectId &&
          input.host === "github.com" &&
          input.repository === canonicalRepository,
      ),
    ).toBe(true);
    expect(textContent(renderer!.root)).toContain(issue.title);
  });

  it("loads and presents every GitHub project when no project filter is selected", async () => {
    const secondEnvironmentId = EnvironmentId.make("issues-second-environment");
    const secondProjectId = ProjectId.make("issues-second-project");
    harness.search = {};
    harness.projects = [
      ...harness.projects,
      {
        id: secondProjectId,
        environmentId: secondEnvironmentId,
        title: "Second GitHub project",
        repositoryIdentity: {
          provider: "github",
          canonicalKey: "github.com/acme/second",
          displayName: "acme/second",
          owner: "acme",
          name: "second",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/acme/second.git",
          },
        },
      },
    ];
    harness.environments = [
      ...harness.environments,
      {
        environmentId: secondEnvironmentId,
        label: "Second environment",
        serverConfig: { environment: { capabilities: { githubIssues: true } } },
      },
    ];
    harness.resultFor.mockImplementation((input: IssueListInput) => {
      const second = input.projectId === secondProjectId;
      return AsyncResult.success({
        ...success.value,
        repository: {
          projectId: input.projectId,
          host: "github.com",
          repository: second ? "acme/second" : canonicalRepository,
        },
        projectTitle: second ? "Second GitHub project" : "Canonical GitHub project",
        issues: [
          {
            ...issue,
            number: second ? 8 : 7,
            title: second ? "Issue from the second project" : issue.title,
          },
        ],
      });
    });

    await act(async () => {
      renderer = create(<IssuesRoute />);
    });

    expect(new Set(harness.listRequests.map((request) => request.input.projectId))).toEqual(
      new Set([projectId, secondProjectId]),
    );
    const rendered = textContent(renderer!.root);
    expect(rendered).toContain("Canonical GitHub project");
    expect(rendered).toContain("Second GitHub project");
    expect(rendered).toContain(issue.title);
    expect(rendered).toContain("Issue from the second project");
    expect(renderer!.root.findByProps({ "aria-label": "GitHub project" }).props.value).toBe("");
  });
});
