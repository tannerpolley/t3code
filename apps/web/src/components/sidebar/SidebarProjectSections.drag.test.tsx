// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type SidebarLayoutMutation } from "@t3tools/contracts";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { configureSidebarLayoutActions, useUiStateStore } from "../../uiStateStore";
import { SidebarProjectSections } from "./SidebarProjectSections";

vi.mock("../../hooks/useSidebarLayoutPermission", () => ({
  useSidebarLayoutPermission: () => true,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ codexStyleSidebar: true, sectionFolderColors: false }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./NewSectionProjectDialog", () => ({ NewSectionProjectDialog: () => null }));

const names = ["t3code", "stimulant-tracker", "monitor-control", "fly-tree", "process-monitor"];
const projects = buildSidebarProjectSnapshots({
  projects: names.map((name) => ({
    id: ProjectId.make(name),
    environmentId: EnvironmentId.make("local"),
    title: name,
    workspaceRoot: "/work/" + name,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  })),
  settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: EnvironmentId.make("local"),
  resolveEnvironmentLabel: () => null,
});
const section = {
  id: "applications",
  name: "Applications",
  collapsed: false,
  projectKeys: projects.map((project) => project.projectKey),
};
const emptySection = { id: "tools", name: "Tools", collapsed: false, projectKeys: [] };
const send = vi.fn<(mutation: SidebarLayoutMutation) => Promise<boolean>>(async () => true);
let root: Root;
let container: HTMLDivElement;
let mixedRows: readonly string[] | null = null;

beforeEach(() => {
  mixedRows = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no layout; give the real sortable registrations fixed, non-overlapping rows.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (mixedRows) {
      const header = this.dataset.testid;
      const label =
        header === "sidebar-project-section-idaes"
          ? "IDAES"
          : this.querySelector(":scope > div > button > span.truncate")?.textContent;
      const index = mixedRows.indexOf(label ?? "");
      if (index >= 0) return new DOMRect(12, 28 + index * 32, 288, 28);
      return new DOMRect(0, 0, 300, 240);
    }
    const name = this.querySelector(":scope > div > button > span.truncate")?.textContent;
    const index = names.indexOf(name ?? "");
    if (index >= 0) return new DOMRect(12, 28 + index * 32, 288, 32);
    const header =
      this.dataset.testid ?? this.querySelector("[data-testid]")?.getAttribute("data-testid");
    const top = header === "sidebar-project-section-tools" ? 188 : 0;
    if (this.dataset.testid?.startsWith("sidebar-project-section-"))
      return new DOMRect(0, top, 300, 28);
    return new DOMRect(0, top, 300, top === 188 ? 60 : 188);
  });
  configureSidebarLayoutActions(send);
  send.mockClear();
  useUiStateStore.setState({
    sidebarProjectSections: [section],
    sidebarOtherProjectsExpanded: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  configureSidebarLayoutActions(async () => false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  sections: ComponentProps<typeof SidebarProjectSections>["sections"] = [section, emptySection],
) {
  const noop = () => {};
  const props: ComponentProps<typeof SidebarProjectSections> = {
    projects,
    sections,
    selectedProjectKey: null,
    activeThreadKey: null,
    isProjectExpanded: () => false,
    threadsByProjectKey: new Map(),
    runningSubagentsByParentKey: new Map(),
    onAddProject: noop,
    onNewSection: noop,
    onNewSubsection: noop,
    onRenameSection: noop,
    onNewThreadInProject: noop,
    onOpenProjectSettings: noop,
    onRemoveProject: noop,
    onSelectProject: noop,
    onThreadClick: noop,
    onThreadContextMenu: noop,
    onToggleProject: noop,
  };
  await act(() => root.render(<SidebarProjectSections {...props} />));
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
    await render();
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
    await pointer(button, "pointerdown", fromY);
    await pointer(document, "pointermove", fromY - 8);
    await pointer(document, "pointermove", toY);
    const line = container.querySelector("li[aria-hidden]");
    expect(line).not.toBeNull();
    expect(line?.nextElementSibling?.querySelector("button")?.textContent).toBe(before);
    await pointer(document, "pointerup", toY);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "sectionProjectsOrder",
      sectionId: section.id,
      projectKeys: order.map((index) => projects[index]!.projectKey),
    });
  },
);

it("moves a project into an empty section at the shown landing line", async () => {
  await render();
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "process-monitor",
  )!;
  await pointer(button, "pointerdown", 172);
  await pointer(document, "pointermove", 180);
  await pointer(document, "pointermove", 202);
  expect(
    container.querySelector("li[aria-hidden]")?.parentElement?.parentElement?.textContent,
  ).toContain("Tools");
  await pointer(document, "pointerup", 202);
  expect(send.mock.calls.map(([mutation]) => mutation)).toEqual([
    { type: "move", projectKeys: [projects[4]!.projectKey], sectionId: "tools" },
    { type: "sectionProjectsOrder", projectKeys: [projects[4]!.projectKey], sectionId: "tools" },
  ]);
});

it("still reorders top-level sections", async () => {
  await render();
  const button = container.querySelector(
    '[data-testid="sidebar-project-section-applications"] button',
  )!;
  await pointer(button, "pointerdown", 14);
  await pointer(document, "pointermove", 22);
  await pointer(document, "pointermove", 202);
  await pointer(document, "pointerup", 202);
  expect(send).toHaveBeenCalledExactlyOnceWith({
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
  async ({ drag, from, to, order }) => {
    mixedRows = [names[0]!, "IDAES", ...names.slice(1)];
    await render([
      {
        ...section,
        childOrder: [
          projects[0]!.projectKey,
          "section:idaes",
          ...projects.slice(1).map((p) => p.projectKey),
        ],
      },
      { id: "idaes", name: "IDAES", parentId: section.id, collapsed: true, projectKeys: [] },
    ]);
    const rowLabels = [...container.querySelectorAll("button[aria-expanded]")]
      .map((button) => button.querySelector("span")?.textContent)
      .filter((label) => label !== undefined);
    expect(rowLabels).toEqual(["Applications", ...mixedRows]);
    const button = [...container.querySelectorAll("button[aria-expanded]")].find(
      (candidate) => candidate.querySelector("span")?.textContent === drag,
    )!;
    const fromY = 42 + from * 32,
      toY = 42 + to * 32;
    await pointer(button, "pointerdown", fromY);
    await pointer(document, "pointermove", fromY + 8);
    await pointer(document, "pointermove", toY);
    expect(container.querySelector("li[aria-hidden]")).not.toBeNull();
    await pointer(document, "pointerup", toY);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "sectionChildrenOrder",
      sectionId: section.id,
      childOrder: order.map((key) => (typeof key === "number" ? projects[key]!.projectKey : key)),
    });
  },
);
