import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type IssueWorkStartResult,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

type StartCall = {
  readonly environmentId: EnvironmentId;
  readonly input: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  leads: [] as unknown[],
  providers: new Map<unknown, unknown>(),
  serverConfigs: new Map<unknown, unknown>(),
  status: null as unknown,
  dataUpdatedAt: 0,
  queued: false,
  start: vi.fn<(call: StartCall) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock(import("~/state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useProjects: (() => state.projects) as never,
    useServerConfigs: (() => state.serverConfigs) as never,
    useThreadShell: (() => null) as never,
    useThreadShellsForProjectRefs: (() => state.leads) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const actual = await original();
  return { ...actual, useEnvironmentProviders: (() => state.providers) as never };
});
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: (() => ({
      data: state.status,
      dataUpdatedAt: state.dataUpdatedAt,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
    formatEnvironmentQueryError: () => "Temporary GitHub write failure",
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const actual = await original();
  return { ...actual, useAtomCommand: (() => state.start) as never };
});
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("./IssueQueueAction"), async (original) => {
  const actual = await original();
  return { ...actual, useIssueQueued: (() => state.queued) as never };
});
vi.mock(import("./issueTabs"), async (original) => {
  const actual = await original();
  return { ...actual, useOpenIssueTab: (() => () => {}) as never };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { IssueStartAction } from "./IssueStartAction";

const environmentId = EnvironmentId.make("issue-start-ui");
const issue = { host: "github.com", repository: "owner/repo", number: 67 };
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const leadB = ThreadId.make("lead-b");
const providerInstanceId = ProviderInstanceId.make("codex");
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/owner/repo",
  provider: SourceControlProviderKind.make("github"),
  displayName: "owner/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/owner/repo.git",
  },
  origin: { canonicalKey: "github.com/owner/repo", displayName: "owner/repo" },
};

function setup() {
  state.projects = [
    {
      id: projectA,
      environmentId,
      title: "First project",
      workspaceRoot: "/workspace/first",
      repositoryIdentity: identity,
    },
    {
      id: projectB,
      environmentId,
      title: "Second project",
      workspaceRoot: "/workspace/second",
      repositoryIdentity: identity,
    },
  ];
  state.leads = [
    {
      id: ThreadId.make("lead-a"),
      environmentId,
      projectId: projectA,
      title: "First lead",
      modelSelection: { instanceId: providerInstanceId, model: "codex-model" },
      source: {
        id: ThreadId.make("lead-a"),
        projectId: projectA,
        role: undefined,
        branch: null,
        worktreePath: null,
        lineage: {
          rootThreadId: ThreadId.make("lead-a"),
          parentThreadId: null,
          relationshipToParent: null,
        },
        archivedAt: null,
        deletedAt: null,
        linkedIssue: undefined,
        repositoryOrchestration: undefined,
      },
    },
    {
      id: leadB,
      environmentId,
      projectId: projectB,
      title: "Second lead",
      modelSelection: { instanceId: providerInstanceId, model: "codex-model" },
      source: {
        id: leadB,
        projectId: projectB,
        role: undefined,
        branch: null,
        worktreePath: null,
        lineage: { rootThreadId: leadB, parentThreadId: null, relationshipToParent: null },
        archivedAt: null,
        deletedAt: null,
        linkedIssue: undefined,
        repositoryOrchestration: undefined,
      },
    },
  ];
  state.providers = new Map([
    [environmentId, [{ instanceId: providerInstanceId, driver: ProviderDriverKind.make("codex") }]],
  ]);
  state.serverConfigs = new Map([
    [environmentId, { environment: { capabilities: { issueWork: true } } }],
  ]);
  state.status = {
    issue,
    projectId: null,
    rootThreadId: null,
    threadId: null,
    status: null,
    publishing: "absent",
    pendingRequestId: null,
  };
  state.dataUpdatedAt = 1;
  state.queued = false;
  state.toast.mockReset();
  state.start.mockReset();
  state.start.mockImplementationOnce(async () => {
    state.queued = true;
    return { _tag: "Failure", cause: new Error("write failed") };
  });
  const accepted: IssueWorkStartResult = {
    rootThreadId: leadB,
    issueThreadId: null,
    status: "queued_preparing",
    createdRoot: false,
  };
  state.start.mockResolvedValueOnce({ _tag: "Success", value: accepted });
}

it("starts without a worker role and retries the selected project and lead idempotently", async () => {
  setup();
  await using screen = await render(
    <IssueStartAction
      environmentId={environmentId}
      reference={issue}
      threadRef={null}
      closed={false}
    />,
  );

  await screen.getByRole("button", { name: "Start agent" }).click();
  await screen.getByRole("combobox", { name: "Issue project" }).click();
  await screen.getByRole("option", { name: "Second project", exact: true }).click();
  await screen.getByRole("combobox", { name: "Repository orchestrator" }).click();
  await screen.getByRole("option", { name: "Second lead", exact: true }).click();
  await expect
    .element(screen.getByRole("combobox", { name: "Issue model role" }))
    .not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Start agent" }).nth(1).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "Start request failed: Temporary GitHub write failure. Retry uses the same request.",
    );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Queued");
  await screen.getByRole("button", { name: "Start agent" }).nth(1).click();

  expect(state.start).toHaveBeenCalledTimes(2);
  const first = state.start.mock.calls[0]![0].input;
  const retry = state.start.mock.calls[1]![0].input;
  expect(first).toMatchObject({ projectId: projectB, orchestratorThreadId: leadB });
  expect(first).not.toHaveProperty("modelRoleId");
  expect(retry.clientRequestId).toBe(first.clientRequestId);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Queued");
  await expect.element(screen.getByRole("button", { name: "Start agent" })).not.toBeInTheDocument();
});
