import { EnvironmentId, ThreadId, type RepositoryIssueSummary } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const { openPr, navigate } = vi.hoisted(() => ({ openPr: vi.fn(), navigate: vi.fn() }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => openPr }));
vi.mock("./IssueHoverCard", () => ({
  IssueHoverCard: ({ render }: { render: React.ReactElement }) => render,
}));
vi.mock("./IssueQueueAction", () => ({
  IssueQueueAction: () => null,
  useIssueQueued: () => false,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => navigate,
}));

import { IssueRow } from "./IssueRow";

it("opens the waiting child from the issue row when its sibling is running", async () => {
  openPr.mockReset().mockImplementation((event: Event) => event.preventDefault());
  navigate.mockReset();
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("implementor");
  const prUrl = "https://github.com/acme/repo/pull/12";
  const issue: RepositoryIssueSummary = {
    number: 11,
    title: "A long issue title with room to read",
    url: "https://github.com/acme/repo/issues/11",
    state: "open",
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone: null,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    commentCount: 3,
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/repo",
        number: 12,
        title: "Implementation",
        url: prUrl,
        state: "open",
        isDraft: false,
      },
    ],
    liveWork: [
      {
        threadId,
        title: "Implementor",
        branch: null,
        worktreePath: null,
        pullRequests: [prUrl],
        status: "working",
      },
    ],
  };
  const onSelect = vi.fn();
  const row = (value: RepositoryIssueSummary) => (
    <IssueRow issue={value} environmentId={environmentId} selected={false} onSelect={onSelect} />
  );
  await using screen = await render(row(issue));
  await expect.element(screen.getByRole("img", { name: "In progress" })).toBeVisible();
  await screen
    .getByRole("link", { name: "Open pull request acme/repo#12: Implementation" })
    .click();
  expect(openPr).toHaveBeenCalledWith(expect.anything(), prUrl, undefined, environmentId);
  expect(onSelect).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: /Implementor/ }).click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  });
  expect(onSelect).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: `Open issue #11: ${issue.title}` }).click();
  expect(onSelect).toHaveBeenCalledOnce();

  const reviewerId = ThreadId.make("reviewer");
  await screen.rerender(
    row({
      ...issue,
      liveWork: [
        ...issue.liveWork!,
        {
          ...issue.liveWork![0]!,
          threadId: reviewerId,
          title: "Reviewer",
          inherited: true,
          status: "waiting_on_you",
        },
      ],
    }),
  );
  await screen.getByRole("button", { name: /and 1 more/ }).click();
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: reviewerId },
  });
  expect(onSelect).toHaveBeenCalledOnce();
});
