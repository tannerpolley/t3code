import { type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, type SidebarLayoutMutation } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { configureSidebarLayoutActions, useUiStateStore } from "../../uiStateStore";
import { SidebarProjectSections } from "./SidebarProjectSections";

const commands = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../hooks/useSidebarLayoutPermission", () => ({
  useSidebarLayoutPermission: () => true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select: (settings: object) => unknown) =>
    select({ codexStyleSidebar: true, sectionFolderColors: false })) as never,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.update }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./NewSectionProjectDialog", () => ({ NewSectionProjectDialog: () => null }));

const environmentId = EnvironmentId.make("local");
const names = ["t3code", "stimulant-tracker", "monitor-control", "fly-tree", "process-monitor"];
const projects = buildSidebarProjectSnapshots({
  projects: names.map((name) => ({
    id: ProjectId.make(name),
    environmentId,
    title: name,
    workspaceRoot: "/work/" + name,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...(name === "t3code" ? { projectIcon: { kind: "emoji" as const, emoji: "🌲" } } : {}),
  })),
  settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: environmentId,
  resolveEnvironmentLabel: () => null,
});
const section = {
  id: "applications",
  name: "Applications",
  collapsed: false,
  projectKeys: projects.map((project) => project.projectKey),
};
const emptySection = { id: "tools", name: "Tools", collapsed: false, projectKeys: [] };
type Sections = ComponentProps<typeof SidebarProjectSections>["sections"];

/**
 * Fixed, non-overlapping rows for the real sortable registrations, so drags land the same
 * way on every runner. `mixedRows` lays out a section whose subsection sits among projects.
 */
function setup(mixedRows: readonly string[] | null = null) {
  commands.update.mockReset().mockResolvedValue({ _tag: "Success" });
  const send = vi.fn<(mutation: SidebarLayoutMutation) => Promise<boolean>>(async () => true);
  configureSidebarLayoutActions(send);
  useUiStateStore.setState({
    sidebarProjectSections: [section],
    sidebarOtherProjectsExpanded: true,
    sidebarDisplaySnapshot: null,
  });
  const rects = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const name = this.querySelector(":scope > div > button > span.truncate")?.textContent;
      if (mixedRows) {
        const label =
          this.dataset.testid === "sidebar-project-section-idaes" ? "IDAES" : (name ?? "");
        const index = mixedRows.indexOf(label);
        if (index >= 0) return new DOMRect(12, 28 + index * 32, 288, 28);
        return new DOMRect(0, 0, 300, 240);
      }
      const index = names.indexOf(name ?? "");
      if (index >= 0) return new DOMRect(12, 28 + index * 32, 288, 32);
      const header =
        this.dataset.testid ?? this.querySelector("[data-testid]")?.getAttribute("data-testid");
      const top = header === "sidebar-project-section-tools" ? 188 : 0;
      if (this.dataset.testid?.startsWith("sidebar-project-section-"))
        return new DOMRect(0, top, 300, 28);
      return new DOMRect(0, top, 300, top === 188 ? 60 : 188);
    });
  return {
    send,
    [Symbol.dispose]() {
      rects.mockRestore();
      configureSidebarLayoutActions(async () => false);
      useUiStateStore.setState({ sidebarDisplaySnapshot: null });
    },
  };
}

function view(sections: Sections = [section, emptySection]) {
  const noop = () => {};
  return (
    <SidebarProjectSections
      projects={projects}
      sections={sections}
      selectedProjectKey={null}
      threadRowAssembly={{
        onThreadClick: noop,
        onThreadActivate: noop,
        onStartRename: noop,
        onRenameTitleChange: noop,
        onCommitRename: noop,
        onCancelRename: noop,
        onContextMenu: noop,
        onSettle: noop,
        onActionSweepStart: noop,
        onUnsettle: noop,
        onSnooze: noop,
        onUnsnooze: noop,
        onUnpin: noop,
        onAcknowledgeWoke: noop,
        onFileDropThreads: noop,
        readOpensPullRequestsInRightPanel: () => false,
        timestampFormat: "locale",
        currentEnvironmentId: environmentId,
        environmentLabelById: new Map(),
        environmentMachineById: new Map(),
        projectByKey: new Map(),
        projectDisplayNameByKey: new Map(),
        logicalProjectKeyByScopedProjectRef: new Map(),
        providerEntriesByEnvironment: new Map(),
        serverConfigs: new Map(),
        scratchMachineLabelFor: () => null,
      }}
      threadRowState={{
        activeKey: null,
        routeKey: null,
        revealActiveRow: () => undefined,
        renamingKey: null,
        renamingTitle: "",
        snoozeNow: "2026-10-15T00:00:00.000Z",
      }}
      isProjectExpanded={() => false}
      threadsByProjectKey={new Map()}
      runningSubagentsByParentKey={new Map()}
      onAddProject={noop}
      onNewSection={noop}
      onNewSubsection={noop}
      onRenameSection={noop}
      onNewThreadInProject={noop}
      onProjectContextMenu={noop}
      onOpenProjectSettings={noop}
      onRemoveProject={noop}
      onSelectProject={noop}
      onToggleProject={(key, expanded) =>
        useUiStateStore.getState().setProjectExpanded(key, expanded)
      }
    />
  );
}

async function pointer(target: EventTarget, type: string, y: number) {
  await act(() => {
    target.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: 80, clientY: y, button: 0 }), {
        isPrimary: true,
        pointerId: 1,
      }),
    );
  });
}

async function drag(button: Element, fromY: number, toY: number) {
  await pointer(button, "pointerdown", fromY);
  await pointer(document, "pointermove", fromY + (toY > fromY ? 8 : -8));
  await pointer(document, "pointermove", toY);
  await pointer(document, "pointerup", toY);
}

const rowButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].find(
    (candidate) => candidate.querySelector("span.truncate")?.textContent === label,
  )!;

it.each([
  {
    name: "process-monitor",
    fromY: 172,
    toY: 76,
    before: "stimulant-tracker",
    order: [0, 4, 1, 2, 3],
  },
  {
    name: "monitor-control",
    fromY: 108,
    toY: 140,
    before: "process-monitor",
    order: [0, 1, 3, 2, 4],
  },
])(
  "shows the landing line and commits a $name reorder in Applications",
  async ({ name, fromY, toY, before, order }) => {
    using fixture = setup();
    await using screen = await render(view());
    const button = rowButton(screen.container, name);
    await pointer(button, "pointerdown", fromY);
    await pointer(document, "pointermove", fromY - 8);
    await pointer(document, "pointermove", toY);
    const line = screen.container.querySelector("li[aria-hidden]");
    expect(line).not.toBeNull();
    expect(line?.nextElementSibling?.querySelector("span.truncate")?.textContent).toBe(before);
    await pointer(document, "pointerup", toY);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: "sectionProjectsOrder",
      sectionId: section.id,
      projectKeys: order.map((index) => projects[index]!.projectKey),
    });
  },
);

it("moves a project into an empty section at the shown landing line", async () => {
  using fixture = setup();
  await using screen = await render(view());
  const button = rowButton(screen.container, "process-monitor");
  await pointer(button, "pointerdown", 172);
  await pointer(document, "pointermove", 180);
  await pointer(document, "pointermove", 202);
  expect(
    screen.container.querySelector("li[aria-hidden]")?.parentElement?.parentElement?.textContent,
  ).toContain("Tools");
  await pointer(document, "pointerup", 202);
  expect(fixture.send.mock.calls.map(([mutation]) => mutation)).toEqual([
    { type: "move", projectKeys: [projects[4]!.projectKey], sectionId: "tools" },
    { type: "sectionProjectsOrder", projectKeys: [projects[4]!.projectKey], sectionId: "tools" },
  ]);
});

it("still reorders top-level sections", async () => {
  using fixture = setup();
  await using screen = await render(view());
  const button = screen.container.querySelector(
    '[data-testid="sidebar-project-section-applications"] button',
  )!;
  await drag(button, 14, 202);
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
    type: "sectionsOrder",
    sectionIds: ["tools", "applications"],
  });
});

it.each([
  { drag: "IDAES", from: 1, to: 0, order: ["section:idaes", 0, 1, 2, 3, 4] },
  { drag: "IDAES", from: 1, to: 2, order: [0, 1, "section:idaes", 2, 3, 4] },
  { drag: "t3code", from: 0, to: 1, order: ["section:idaes", 0, 1, 2, 3, 4] },
  { drag: "stimulant-tracker", from: 2, to: 1, order: [0, 1, "section:idaes", 2, 3, 4] },
])(
  "drags $drag from mixed row $from to $to and saves the shared order",
  async ({ drag: label, from, to, order }) => {
    const mixedRows = [names[0]!, "IDAES", ...names.slice(1)];
    using fixture = setup(mixedRows);
    await using screen = await render(
      view([
        {
          ...section,
          childOrder: [
            projects[0]!.projectKey,
            "section:idaes",
            ...projects.slice(1).map((p) => p.projectKey),
          ],
        },
        { id: "idaes", name: "IDAES", parentId: section.id, collapsed: true, projectKeys: [] },
      ]),
    );
    const rowLabels = [...screen.container.querySelectorAll("[data-sidebar-row]")].map(
      (button) => button.querySelector("span.truncate")?.textContent,
    );
    expect(rowLabels).toEqual(["Applications", ...mixedRows]);
    const fromY = 42 + from * 32,
      toY = 42 + to * 32;
    const button = rowButton(screen.container, label);
    await pointer(button, "pointerdown", fromY);
    await pointer(document, "pointermove", fromY + 8);
    await pointer(document, "pointermove", toY);
    expect(screen.container.querySelector("li[aria-hidden]")).not.toBeNull();
    await pointer(document, "pointerup", toY);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      type: "sectionChildrenOrder",
      sectionId: section.id,
      childOrder: order.map((key) => (typeof key === "number" ? projects[key]!.projectKey : key)),
    });
  },
);

it("a displayed layout snapshot blocks expansion, drops and icon resets until it lifts", async () => {
  using fixture = setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await using screen = await render(view());
  const resetIcons = async () => {
    await userEvent.click(page.getByRole("button", { name: "Actions for Applications" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Reset project icons…" }));
  };
  await act(() =>
    useUiStateStore.setState({
      sidebarDisplaySnapshot: { environmentIds: [environmentId], expiresAt: Date.UTC(2100, 0) },
    }),
  );
  for (const label of ["Applications", "t3code"]) rowButton(screen.container, label).click();
  await drag(rowButton(screen.container, "process-monitor"), 172, 202);
  await drag(rowButton(screen.container, "monitor-control"), 108, 140);
  await resetIcons();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(commands.update).not.toHaveBeenCalled();

  await act(() => useUiStateStore.setState({ sidebarDisplaySnapshot: null }));
  await drag(rowButton(screen.container, "process-monitor"), 172, 202);
  expect(fixture.send).toHaveBeenCalledWith({
    type: "move",
    projectKeys: [projects[4]!.projectKey],
    sectionId: "tools",
  });
  await resetIcons();
  expect(confirm).toHaveBeenCalledOnce();
  expect(commands.update).toHaveBeenCalledWith({
    environmentId,
    input: { projectId: projects[0]!.id, faviconPath: null, projectIcon: null },
  });
  confirm.mockRestore();
});

it("moves focus through section, subsection and project rows with the arrow keys", async () => {
  using _fixture = setup();
  await using screen = await render(
    view([
      { ...section, projectKeys: [projects[0]!.projectKey] },
      {
        id: "idaes",
        name: "IDAES",
        parentId: section.id,
        collapsed: false,
        projectKeys: [projects[1]!.projectKey],
      },
    ]),
  );
  const row = (label: string) => rowButton(screen.container, label);
  // Rows: Applications, IDAES, stimulant-tracker (in IDAES), t3code.
  row(names[0]!).focus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(row("Applications")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(row("IDAES")).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(row(names[1]!)).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(row("IDAES")).toHaveFocus();
});
