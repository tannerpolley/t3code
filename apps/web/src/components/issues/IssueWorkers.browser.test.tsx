import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type RepositoryIssueSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "~/test-fixtures";
import { render } from "../../../test/render";
import { IssueWorkers } from "./IssueWorkers";

const state = vi.hoisted(() => ({
  respond: vi.fn(),
  shells: new Map<string, ReturnType<typeof makeThreadFixture>>(),
  requests: null as Atom.Atom<PendingThreadRequests> | null,
}));

vi.mock("~/state/entities", () => ({
  useProject: () => null,
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref === null ? null : (state.shells.get(ref.threadId) ?? null),
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("~/state/threads", () => ({
  childThreadApprovalsAtom: () => null,
  environmentThreadDetails: { pendingRequestsAtom: () => state.requests },
  threadEnvironment: {},
}));

it("lets the owner answer in the issue after routing hands the request back to them", async () => {
  state.shells.clear();
  state.respond.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("worker-env");
  const parent = makeThreadFixture({ environmentId, id: ThreadId.make("parent"), title: "Parent" });
  const child = makeThreadFixture({ environmentId, id: ThreadId.make("child"), title: "Reviewer" });
  const requestId = RuntimeRequestId.make("child-question");
  const request = {
    id: requestId,
    kind: "user_input" as const,
    createdAt: child.source.updatedAt,
    routedTo: parent.id,
  };
  state.shells.set(parent.id, { ...parent, source: { ...parent.source, status: "running" } });
  state.shells.set(child.id, {
    ...child,
    source: { ...child.source, pendingRuntimeRequest: request },
  });
  state.requests = Atom.make<PendingThreadRequests>({
    approvals: [],
    userInputs: [
      {
        requestId,
        createdAt: child.updatedAt,
        routedTo: parent.id,
        dismissible: true,
        responseCapability: "message",
        questions: [
          {
            id: "target",
            header: "Branch",
            question: "Which branch should I inspect?",
            multiSelect: false,
            options: [],
          },
        ],
      },
    ],
  });
  const issue: RepositoryIssueSummary = {
    number: 429,
    title: "Issue",
    url: "https://github.com/owner/repo/issues/429",
    state: "open",
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: child.updatedAt,
    updatedAt: child.updatedAt,
    commentCount: 0,
    liveWork: [
      {
        threadId: child.id,
        title: child.title,
        branch: "issue-429",
        worktreePath: null,
        pullRequests: [],
        status: "question",
      },
    ],
  };
  await using screen = await render(<IssueWorkers issue={issue} environmentId={environmentId} />);
  await expect.element(screen.getByText("Routed to Parent")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Submit" })).not.toBeInTheDocument();

  state.shells.set(parent.id, parent);
  await screen.rerender(<IssueWorkers issue={issue} environmentId={environmentId} />);
  await screen.getByRole("textbox", { name: "Your own answer" }).fill("main");
  await screen.getByRole("button", { name: "Submit" }).click();
  expect(state.respond).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId: child.id, requestId, answers: { target: "main" } },
  });

  // Another surface settled the request while this detail remained open.
  state.shells.set(child.id, child);
  await screen.rerender(<IssueWorkers issue={issue} environmentId={environmentId} />);
  await expect.element(screen.getByRole("button", { name: "Submit" })).not.toBeInTheDocument();
});
