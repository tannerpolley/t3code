import { EnvironmentId, type RepositoryIssueSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useUiStateStore } from "~/uiStateStore";
import { IssueRoadmap } from "./IssueRoadmap";

vi.mock("./IssueQueueAction", () => ({ useIssueQueue: () => ({ supported: true, data: null }) }));
vi.mock("./IssueInbox", () => ({
  useIssueInbox: () => ({ data: null }),
  IssueInboxSection: () => null,
}));
vi.mock("./IssueRow", () => ({ IssueRow: () => null }));

const issue: RepositoryIssueSummary = {
  number: 1,
  title: "Ready issue",
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
    for (const section of ["Done", "In progress", "Queued", "Ready", "Blocked"]) {
      const button = screen.getByRole("region", { name: section, exact: true }).getByRole("button");
      await expect.element(button).toHaveAttribute("aria-expanded", "true");
      await button.click();
      await expect.element(button).toHaveAttribute("aria-expanded", "false");
    }
    await expect
      .element(screen.getByRole("region", { name: "Closed", exact: true }).getByRole("button"))
      .toHaveAttribute("aria-expanded", "false");
    await screen.rerender(roadmap("owner/repo", [{ ...issue, title: "Refreshed" }]));
    await expect.element(screen.getByRole("listitem")).not.toBeInTheDocument();
    await screen.rerender(roadmap("owner/other"));
    await expect.element(screen.getByRole("listitem")).toBeInTheDocument();
  }
  await using screen = await render(roadmap());
  await expect.element(screen.getByRole("listitem")).not.toBeInTheDocument();
  await screen.getByRole("region", { name: "Ready", exact: true }).getByRole("button").click();
  await expect.element(screen.getByRole("listitem")).toBeInTheDocument();
  for (const section of ["Done", "In progress", "Queued", "Blocked"]) {
    await expect
      .element(screen.getByRole("region", { name: section, exact: true }).getByRole("button"))
      .toHaveAttribute("aria-expanded", "false");
  }
});
