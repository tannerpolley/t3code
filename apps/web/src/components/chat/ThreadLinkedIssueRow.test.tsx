import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { IssueDetailResult } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

const state = vi.hoisted(() => ({
  shells: null as Atom.Writable<readonly EnvironmentThreadShell[]> | null,
  detail: null as Atom.Writable<AsyncResult.AsyncResult<IssueDetailResult>> | null,
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  state.shells = Atom.make<readonly EnvironmentThreadShell[]>([]);
  return { environmentThreadShells: { threadShellsAtom: state.shells } };
});
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  state.detail = Atom.make<AsyncResult.AsyncResult<IssueDetailResult>>(AsyncResult.initial());
  return { createIssueEnvironmentAtoms: () => ({ detail: () => state.detail }) };
});
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("../../state/entities", async () => {
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  return {
    useThreadShell: () => appAtomRegistry.get(state.shells!)[0],
    useAllEnvironmentShellsBootstrapped: () => true,
  };
});
vi.mock("./ThreadDetailsControl", () => ({
  ThreadDetailsControl: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { makeThreadFixture } from "../../test-fixtures";
import { ThreadLinkedIssueRow } from "./ThreadLinkedIssueRow";

it("updates the Linked issue row from the shell stream while the cached issue detail stays idle", async () => {
  const linkedIssue = {
    host: "github.com",
    repository: "owner/repo",
    number: 43,
    title: "Fix",
    repositoryId: "repo",
    id: "43",
    nodeId: "I_43",
    url: "https://github.com/owner/repo/issues/43",
  };
  const thread = makeThreadFixture({ linkedIssue });
  const detail: IssueDetailResult = {
    repository: linkedIssue,
    viewer: null,
    fetchedAt: thread.updatedAt,
    body: "",
    comments: [],
    linkedPullRequests: [],
    issue: {
      ...linkedIssue,
      state: "open",
      stateReason: null,
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: thread.updatedAt,
      updatedAt: thread.updatedAt,
      commentCount: 0,
      liveWork: [
        {
          threadId: thread.id,
          title: thread.title,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          status: "idle",
        },
      ],
    },
  };
  appAtomRegistry.set(state.shells!, [thread]);
  const cached = AsyncResult.success(detail);
  appAtomRegistry.set(state.detail!, cached);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <AppAtomRegistryProvider>
          <ThreadLinkedIssueRow environmentId={thread.environmentId} threadId={thread.id} />
        </AppAtomRegistryProvider>,
      );
    });
    const displayed = () => JSON.stringify(renderer!.toJSON());
    expect(displayed()).not.toContain("In progress");
    const working = {
      ...thread,
      runtime: {
        status: "running" as const,
        activeRunId: RunId.make("run"),
        providerInstanceId: thread.providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: thread.updatedAt,
      },
    };
    await act(async () => {
      appAtomRegistry.set(state.shells!, [working]);
    });
    expect(displayed()).toContain("In progress");
    await act(async () => {
      appAtomRegistry.set(state.shells!, [{ ...working, hasPendingUserInput: true }]);
    });
    expect(displayed()).not.toContain("In progress");
    expect(appAtomRegistry.get(state.detail!)).toBe(cached);
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
