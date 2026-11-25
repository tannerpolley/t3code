import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type RepositoryIssueSummary,
  type ScopedThreadRef,
  type WorktreeSetupSnapshot,
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
  setup: null as Atom.Atom<AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, never>> | null,
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
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { worktreeSetup: () => state.setup } }));

function issueWithWorker(
  child: ReturnType<typeof makeThreadFixture>,
  status: "question" | "working",
) {
  return {
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
        status,
      },
    ],
  } satisfies RepositoryIssueSummary;
}

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
  const issue = issueWithWorker(child, "question");
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

it("shows the slot wait reason on the preparing worker's row", async () => {
  state.shells.clear();
  const worker = makeThreadFixture({ id: ThreadId.make("preparing-worker"), title: "Implementor" });
  state.shells.set(worker.id, {
    ...worker,
    source: { ...worker.source, activityRunStatus: "preparing" },
  });
  const detail = "/repo/.worktrees/slot-1 is reserved by another thread or terminal";
  state.setup = Atom.make<AsyncResult.AsyncResult<WorktreeSetupSnapshot | null, never>>(
    AsyncResult.success({
      threadId: worker.id,
      phase: "running",
      startedAt: worker.updatedAt,
      endedAt: null,
      branch: null,
      baseRef: "main",
      worktreePath: null,
      setupScript: null,
      stages: [
        {
          id: "checkout",
          status: "pending",
          startedAt: null,
          endedAt: null,
          percent: null,
          detail,
          tail: [],
        },
      ],
      error: null,
      sequence: 1,
    }),
  );
  const issue = issueWithWorker(worker, "working");
  await using screen = await render(
    <IssueWorkers issue={issue} environmentId={worker.environmentId} />,
  );
  const row = screen.getByRole("listitem").filter({ hasText: worker.title });
  await expect.element(row.getByText(detail)).toBeVisible();

  await screen.rerender(
    <IssueWorkers
      issue={{
        ...issue,
        liveWork: issue.liveWork.map((entry) => ({
          ...entry,
          worktreePath: "/repo/.worktrees/slot-1",
        })),
      }}
      environmentId={worker.environmentId}
    />,
  );
  await expect.element(row.getByText(detail)).not.toBeInTheDocument();
});
