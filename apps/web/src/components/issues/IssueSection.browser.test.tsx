import { EnvironmentId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { useUiStateStore } from "~/uiStateStore";
import { IssueSection } from "./IssueSection";
import { issueSectionCollapsedSelector, issueSectionKey } from "./useIssueSectionCollapsed";

const scope = {
  environmentId: EnvironmentId.make("environment-a"),
  host: "github.com",
  repository: "owner/repo",
};

it("isolates Ready, Inbox and milestone selections across environments", () => {
  const other = { ...scope, environmentId: EnvironmentId.make("environment-b") };
  for (const section of ["roadmap:ready", "inbox", "milestone:1"]) {
    const initial = { issueMilestoneCollapsedById: {} };
    const changed = { issueMilestoneCollapsedById: { [issueSectionKey(scope, section)]: true } };
    expect(issueSectionCollapsedSelector(scope, section)(changed)).toBe(true);
    const selectOther = issueSectionCollapsedSelector(other, section);
    expect(selectOther(changed)).toBe(selectOther(initial));
    expect(selectOther(changed)).toBe(false);
  }
});

it("reads legacy milestone choices and lets an environment explicitly reopen them", async () => {
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  useUiStateStore.setState({
    issueMilestoneCollapsedById: { "github.com/owner/repo:milestone:1": true },
  });
  await using screen = await render(
    <IssueSection scope={scope} section="milestone:1">
      {(collapsed, toggle) => <button aria-expanded={!collapsed} onClick={toggle} />}
    </IssueSection>,
  );
  expect(screen.container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  await act(() => screen.container.querySelector("button")!.click());
  expect(screen.container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  expect(
    useUiStateStore.getState().issueMilestoneCollapsedById[issueSectionKey(scope, "milestone:1")],
  ).toBe(false);
  expect(
    useUiStateStore.getState().issueMilestoneCollapsedById["github.com/owner/repo:milestone:1"],
  ).toBe(true);
});

it("rerenders only the toggled section, including when another repository has the same section", async () => {
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  const sections = [
    { scope, section: "roadmap:ready" },
    { scope, section: "inbox" },
    { scope: { ...scope, repository: "owner/other" }, section: "roadmap:ready" },
  ];
  const renders = sections.map(() => vi.fn());
  await using screen = await render(
    <>
      {sections.map((entry, index) => (
        <IssueSection key={issueSectionKey(entry.scope, entry.section)} {...entry}>
          {(collapsed, toggle) => {
            renders[index]!();
            return <button aria-expanded={!collapsed} onClick={toggle} />;
          }}
        </IssueSection>
      ))}
    </>,
  );
  for (const render of renders) render.mockClear();
  await act(() => screen.container.querySelector("button")!.click());
  expect(renders[0]).toHaveBeenCalledTimes(1);
  expect(renders[1]).not.toHaveBeenCalled();
  expect(renders[2]).not.toHaveBeenCalled();
});
