import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useUiStateStore } from "~/uiStateStore";
import { IssueSection } from "./IssueSection";
import { issueSectionCollapsedSelector, issueSectionKey } from "./useIssueSectionCollapsed";

const scope = {
  environmentId: EnvironmentId.make("environment-a"),
  host: "github.com",
  repository: "owner/repo",
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useUiStateStore.setState({ issueMilestoneCollapsedById: {} });
  vi.unstubAllGlobals();
});

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStateStore.setState({
    issueMilestoneCollapsedById: { "github.com/owner/repo:milestone:1": true },
  });
  await act(async () => {
    renderer = create(
      <IssueSection scope={scope} section="milestone:1">
        {(collapsed, toggle) => <button aria-expanded={!collapsed} onClick={toggle} />}
      </IssueSection>,
    );
  });
  expect(renderer!.root.findByType("button").props["aria-expanded"]).toBe(false);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(renderer!.root.findByType("button").props["aria-expanded"]).toBe(true);
  expect(
    useUiStateStore.getState().issueMilestoneCollapsedById[issueSectionKey(scope, "milestone:1")],
  ).toBe(false);
  expect(
    useUiStateStore.getState().issueMilestoneCollapsedById["github.com/owner/repo:milestone:1"],
  ).toBe(true);
});

it("rerenders only the toggled section, including when another repository has the same section", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const sections = [
    { scope, section: "roadmap:ready" },
    { scope, section: "inbox" },
    { scope: { ...scope, repository: "owner/other" }, section: "roadmap:ready" },
  ];
  const renders = sections.map(() => vi.fn());
  await act(async () => {
    renderer = create(
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
  });
  for (const render of renders) render.mockClear();
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(renders[0]).toHaveBeenCalledTimes(1);
  expect(renders[1]).not.toHaveBeenCalled();
  expect(renders[2]).not.toHaveBeenCalled();
});
