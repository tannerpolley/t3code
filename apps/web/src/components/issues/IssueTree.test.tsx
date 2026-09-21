import type { IssueMilestone, IssueSummary } from "@t3tools/contracts";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { IssueTree } from "./IssueTree";
import { groupIssuesByMilestone } from "./issueTree.logic";

const milestone: IssueMilestone = {
  number: 1,
  title: "Release",
  state: "open",
  dueAt: null,
  url: "https://github.com/owner/repo/milestone/1",
  openCount: 1,
  closedCount: 0,
};
const issue: IssueSummary = {
  number: 42,
  title: "Keep the navigator usable",
  url: "https://github.com/owner/repo/issues/42",
  state: "open",
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  milestone,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-21T00:00:00Z",
  commentCount: 0,
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("expands a milestone when its first issue arrives and preserves a user's collapse on refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = (issues: readonly IssueSummary[], complete: boolean) => (
    <StrictMode>
      <IssueTree
        groups={groupIssuesByMilestone([milestone], issues)}
        issuesComplete={complete}
        onSelect={() => {}}
      />
    </StrictMode>
  );
  await act(async () => {
    renderer = create(render([], false));
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);

  await act(async () => {
    renderer!.update(render([issue], true));
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(1);

  const disclosure = () =>
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-expanded"] !== undefined)!;
  await act(async () => {
    disclosure().props.onClick();
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);

  await act(async () => {
    renderer!.update(render([{ ...issue, title: "Updated title" }], true));
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);
  await act(async () => {
    disclosure().props.onClick();
  });
  expect(renderer!.root.findAllByType("li")).toHaveLength(1);
});
