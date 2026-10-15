import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: "update" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.update }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => true } }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    updateSidebarLayout: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(
    select: (settings: { codexStyleSidebar: boolean; sectionFolderColors: boolean }) => T,
  ) => select({ codexStyleSidebar: true, sectionFolderColors: true }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
// Menu portals and drag sensors are browser boundaries; keep the real sidebar handlers.
vi.mock("../ui/menu", () => ({
  Menu: "menu-root",
  MenuItem: "button",
  MenuPopup: "menu-popup",
  MenuSeparator: "menu-separator",
  MenuSub: "menu-sub",
  MenuSubPopup: "menu-sub-popup",
  MenuSubTrigger: "menu-sub-trigger",
  MenuTrigger: "menu-trigger",
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: "section",
  DragOverlay: "drag-overlay",
  KeyboardSensor: {},
  PointerSensor: {},
  closestCorners: vi.fn(),
  pointerWithin: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
  useDroppable: () => ({}),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: "sortable-context",
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: {},
  arrayMove: (items: string[], from: number, to: number) => {
    const copy = [...items];
    copy.splice(to, 0, ...copy.splice(from, 1));
    return copy;
  },
  useSortable: () => ({}),
}));
vi.mock("./NewSectionProjectDialog", () => ({ NewSectionProjectDialog: () => null }));
vi.mock("./SidebarThreadProcesses", () => ({
  useSidebarThreadProcesses: vi.fn(),
  SidebarProcessGroupRows: () => null,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuButton: "sidebar-button",
  SidebarMenuItem: "sidebar-item",
}));

import { SidebarProjectSections } from "./SidebarProjectSections";
import { configureSidebarLayoutActions, useUiStateStore } from "../../uiStateStore";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  configureSidebarLayoutActions(async () => false);
  useUiStateStore.setState({ sidebarDisplaySnapshot: null });
  vi.unstubAllGlobals();
});
it("snapshot sections cannot expand, reorder or reset icons, including direct handler calls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.fn(() => true);
  vi.stubGlobal("window", { confirm });
  commands.update.mockReset().mockResolvedValue({ _tag: "Success" });
  const send = vi.fn(async () => true);
  configureSidebarLayoutActions(send);
  const environmentId = EnvironmentId.make("local");
  const projects = buildSidebarProjectSnapshots({
    projects: [
      {
        environmentId,
        id: ProjectId.make("project"),
        title: "Project",
        workspaceRoot: "/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        projectIcon: { kind: "emoji", emoji: "🌲" },
      },
    ],
    settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => null,
  });
  const sections = [
    {
      id: JSON.stringify([environmentId, "work"]),
      name: "Work",
      collapsed: false,
      projectKeys: [projects[0]!.projectKey],
    },
    {
      id: JSON.stringify([environmentId, "empty"]),
      name: "Empty",
      collapsed: false,
      projectKeys: [],
    },
  ];
  useUiStateStore.setState({
    sidebarDisplaySnapshot: { environmentIds: [environmentId], expiresAt: Date.now() + 15_000 },
    sidebarProjectSections: sections,
  });
  const props: ComponentProps<typeof SidebarProjectSections> = {
    projects,
    sections,
    selectedProjectKey: null,
    onSelectProject: vi.fn(),
    onAddProject: vi.fn(),
    onNewSection: vi.fn(),
    onNewSubsection: vi.fn(),
    onRenameSection: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onNewThreadInProject: vi.fn(),
    onRemoveProject: vi.fn(),
    threadsByProjectKey: new Map(),
    runningSubagentsByParentKey: new Map(),
    isProjectExpanded: () => false,
    onToggleProject: (key, expanded) =>
      useUiStateStore.getState().setProjectExpanded(key, expanded),
    activeThreadKey: null,
    onThreadClick: vi.fn(),
    onThreadContextMenu: vi.fn(),
  };
  await act(() => {
    renderer = create(<SidebarProjectSections {...props} />);
  });
  const reset = () =>
    renderer!.root.findAll(
      (node) => node.type === "button" && node.children.includes("Reset project icons…"),
    )[0]!;
  await act(async () => {
    // Calling handlers even when controls are disabled checks the write boundary too.
    for (const button of renderer!.root
      .findAllByType("button")
      .filter((node) => node.props["aria-expanded"] !== undefined))
      button.props.onClick();
    await reset().props.onClick();
    renderer!.root.findByType("section").props.onDragEnd({
      active: { id: "section", data: { current: { type: "section", sectionId: sections[0]!.id } } },
      over: { id: "target", data: { current: { type: "section", sectionId: sections[1]!.id } } },
    });
  });
  expect(send).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(commands.update).not.toHaveBeenCalled();
  await act(() => useUiStateStore.setState({ sidebarDisplaySnapshot: null }));
  await act(async () => {
    await reset().props.onClick();
  });
  expect(confirm).toHaveBeenCalledOnce();
  expect(commands.update).toHaveBeenCalledWith({
    environmentId,
    input: { projectId: projects[0]!.id, faviconPath: null, projectIcon: null },
  });
});
