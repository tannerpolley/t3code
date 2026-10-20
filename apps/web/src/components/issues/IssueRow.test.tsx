// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type IssueSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { openPr, navigate } = vi.hoisted(() => ({ openPr: vi.fn(), navigate: vi.fn() }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => openPr }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import { IssueRow } from "./IssueRow";

it("keeps issue, PR and live-agent navigation separate as the issue's live state changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("implementor");
  const prUrl = "https://github.com/acme/repo/pull/12";
  const issue: IssueSummary = {
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (value: IssueSummary) =>
    root.render(
      <IssueRow issue={value} environmentId={environmentId} selected={false} onSelect={onSelect} />,
    );
  const click = async (label: string) => {
    const control = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    expect(control).not.toBeNull();
    await act(async () => control!.click());
  };
  try {
    await act(async () => render(issue));
    expect(
      container.querySelector('[role="img"][aria-label="In progress"]')?.getAttribute("class"),
    ).toContain("text-sky-600");
    await click("Open pull request acme/repo#12: Implementation");
    expect(openPr).toHaveBeenCalledWith(expect.anything(), prUrl, undefined, environmentId);
    expect(onSelect).not.toHaveBeenCalled();
    await click("Working: Implementor");
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
    expect(onSelect).not.toHaveBeenCalled();
    await click(`Open issue #11: ${issue.title}`);
    expect(onSelect).toHaveBeenCalledOnce();

    await act(async () =>
      render({ ...issue, liveWork: [{ ...issue.liveWork![0]!, status: "waiting_on_you" }] }),
    );
    expect(
      container.querySelector('[role="img"][aria-label="In progress"]')?.getAttribute("class"),
    ).toContain("text-sky-600");
    await click("Waiting on you: Implementor");
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
