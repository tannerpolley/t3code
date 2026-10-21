import { EnvironmentId, type IssueSummary } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useUiStateStore } from "~/uiStateStore";
import { IssueRoadmap } from "./IssueRoadmap";

vi.mock("./IssueQueueAction", () => ({ useIssueQueue: () => ({ supported: true, data: null }) }));
vi.mock("./IssueInbox", () => ({
  useIssueInbox: () => ({ data: null }),
  IssueInboxSection: () => null,
}));
vi.mock("./IssueRow", () => ({ IssueRow: () => null }));

const issue: IssueSummary = {
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

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  vi.unstubAllGlobals();
});

it("remembers each roadmap section across refreshes, repository changes and remounts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = (repository = "owner/repo", issues = [issue]) => (
    <IssueRoadmap
      scope={{ host: "github.com", repository }}
      environmentId={EnvironmentId.make("local")}
      milestones={[]}
      issues={issues}
      onSelect={() => {}}
    />
  );
  const sections = () => renderer!.root.findAllByType("section");
  const button = (index: number) => sections()[index]!.findByType("button");
  await act(async () => {
    renderer = create(render());
  });
  expect(sections().map((section) => section.props["aria-label"])).toEqual([
    "Closed",
    "Blocked",
    "Ready",
    "Queued",
    "In progress",
    "Done",
  ]);
  expect(sections().map((section) => section.findByType("button").props["aria-expanded"])).toEqual([
    false,
    true,
    true,
    true,
    true,
    true,
  ]);
  for (const index of [1, 2, 3, 4, 5]) {
    await act(async () => button(index).props.onClick());
    expect(button(index).props["aria-expanded"]).toBe(false);
    expect(sections()[index]!.findAllByType("ul")).toHaveLength(0);
  }
  expect(
    button(2)
      .findAllByType("span")
      .some((span) => span.children[0] === "1"),
  ).toBe(true);
  await act(async () => renderer!.update(render("owner/repo", [{ ...issue, title: "Refreshed" }])));
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);
  await act(async () => renderer!.update(render("owner/other")));
  expect(renderer!.root.findAllByType("li")).toHaveLength(1);
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(render());
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);
  await act(async () => button(2).props.onClick());
  expect(renderer!.root.findAllByType("li")).toHaveLength(1);
  expect(button(4).props["aria-expanded"]).toBe(false);
  expect(button(3).props["aria-expanded"]).toBe(false);
  expect(button(1).props["aria-expanded"]).toBe(false);
});
