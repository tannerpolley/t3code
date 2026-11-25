import { EnvironmentId, type RepositoryIssueSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useUiStateStore } from "~/uiStateStore";
import { IssueKanban, IssueRoadmap } from "./IssueRoadmap";

vi.mock("./IssueQueueAction", () => ({ useIssueQueue: () => ({ supported: true, data: null }) }));
vi.mock("./IssueInbox", () => ({
  useIssueInbox: () => ({ data: null }),
  IssueInboxSection: () => null,
}));
vi.mock("./IssueRow", () => ({ IssueRow: () => null }));

const issue: RepositoryIssueSummary = {
  number: 1,
  title: "Backlog issue",
  url: "https://github.com/owner/repo/issues/1",
  state: "open",
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone: null,
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  commentCount: 0,
  blockedBy: [],
  relationshipsComplete: true,
};

it("remembers each roadmap section across refreshes, repository changes and remounts", async () => {
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  const roadmap = (repository = "owner/repo", issues = [issue]) => (
    <IssueRoadmap
      scope={{ host: "github.com", repository }}
      environmentId={EnvironmentId.make("local")}
      issues={issues}
      onSelect={() => {}}
    />
  );
  {
    await using screen = await render(roadmap());
    for (const section of ["Done", "Ready for review", "In progress", "Queued"]) {
      const button = screen.getByRole("region", { name: section, exact: true }).getByRole("button");
      await expect.element(button).toHaveAttribute("aria-expanded", "true");
      await button.click();
      await expect.element(button).toHaveAttribute("aria-expanded", "false");
    }
    const backlog = screen
      .getByRole("region", { name: "Backlog", exact: true })
      .getByRole("button");
    await expect.element(backlog).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByRole("listitem")).not.toBeInTheDocument();
    await backlog.click();
    await expect.element(screen.getByRole("listitem")).toBeInTheDocument();
    await screen.rerender(roadmap("owner/repo", [{ ...issue, title: "Refreshed" }]));
    await expect.element(screen.getByRole("listitem")).toBeInTheDocument();
    await screen.rerender(roadmap("owner/other"));
    await expect.element(screen.getByRole("listitem")).not.toBeInTheDocument();
  }
  await using screen = await render(roadmap());
  await expect.element(screen.getByRole("listitem")).toBeInTheDocument();
  for (const section of ["Done", "Ready for review", "In progress", "Queued"]) {
    await expect
      .element(screen.getByRole("region", { name: section, exact: true }).getByRole("button"))
      .toHaveAttribute("aria-expanded", "false");
  }
});

it("shows the GitHub status and both hold labels independently of live work", async () => {
  await using screen = await render(
    <IssueKanban
      scope={{ host: "github.com", repository: "owner/repo" }}
      environmentId={EnvironmentId.make("local")}
      issues={[
        { ...issue, planningStatus: "Todo", labels: [{ name: "Needs you", color: null }] },
        {
          ...issue,
          number: 2,
          planningStatus: "In review",
          labels: [{ name: "Needs orchestrator", color: null }],
        },
      ]}
      onSelect={() => {}}
    />,
  );
  await expect
    .element(screen.getByRole("region", { name: "Todo", exact: true }).getByText("Needs you"))
    .toBeVisible();
  await expect
    .element(
      screen
        .getByRole("region", { name: "In review", exact: true })
        .getByText("Needs orchestrator"),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Duplicate", exact: true }))
    .toBeVisible();
});

it("stacks a narrow repository board, showing counts and opening terminal sections on demand", async () => {
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  const layout = (width: number) => (
    <div style={{ width }}>
      <IssueKanban
        scope={{ host: "github.com", repository: "owner/stacked" }}
        environmentId={EnvironmentId.make("local")}
        issues={[
          { ...issue, planningStatus: "Todo", labels: [{ name: "Needs you", color: null }] },
          {
            ...issue,
            number: 2,
            planningStatus: "In review",
            labels: [{ name: "Needs orchestrator", color: null }],
          },
          {
            ...issue,
            number: 3,
            state: "closed",
            planningStatus: "Done",
            labels: [{ name: "completed", color: null }],
          },
        ]}
        onSelect={() => {}}
      />
    </div>
  );
  await using screen = await render(layout(360));
  const board = screen.getByRole("group", { name: "Issue board for owner/stacked" });
  await expect.element(board).toHaveClass("flex-col");
  const region = (status: string) => screen.getByRole("region", { name: status, exact: true });
  const toggle = (status: string) => region(status).getByRole("button");
  await expect.element(toggle("Todo")).toHaveTextContent("Todo1");
  await expect.element(toggle("In progress")).toHaveTextContent("In progress0");
  for (const status of ["Todo", "In progress", "In review", "Backlog"]) {
    await expect.element(toggle(status)).toHaveAttribute("aria-expanded", "true");
  }
  for (const status of ["Done", "Not planned", "Duplicate"]) {
    await expect.element(toggle(status)).toHaveAttribute("aria-expanded", "false");
  }
  const top = (status: string) => region(status).element().getBoundingClientRect().top;
  expect(top("Todo")).toBeLessThan(top("In progress"));
  expect(top("In progress")).toBeLessThan(top("In review"));
  expect(top("In review")).toBeLessThan(top("Backlog"));
  await expect.element(region("Todo").getByText("Needs you", { exact: true })).toBeVisible();
  await expect
    .element(region("In review").getByText("Needs orchestrator", { exact: true }))
    .toBeVisible();
  await expect.element(region("Done").getByText("completed")).not.toBeInTheDocument();
  await toggle("Done").click();
  await expect.element(region("Done").getByText("completed")).toBeVisible();
  await screen.rerender(layout(900));
  await expect.element(toggle("Done")).not.toBeInTheDocument();
  await expect.element(board).toHaveClass("overflow-x-auto");
});
