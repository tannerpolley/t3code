import {
  EMPTY_SIDEBAR_LAYOUT,
  EnvironmentId,
  ProjectId,
  type SidebarLayoutRecord,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { Project } from "../types";

const fixture = vi.hoisted(() => ({
  canWrite: true,
  catalogReady: false,
  shellStatuses: new Map<string, EnvironmentShellStatus>(),
  otherRecords: new Map<string, SidebarLayoutRecord>(),
  record: null as SidebarLayoutRecord | null,
  send: vi.fn(),
  version: 0,
  listeners: new Set<() => void>(),
}));
const environmentId = EnvironmentId.make("client-c");
let environmentIds = [environmentId];
let projects: Project[] = [];
let configs = new Map([[environmentId, { sidebarLayoutSync: true }]]);
const grouping = { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} };

vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (atom: string) => {
      useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
        () => fixture.version,
      );
      if (atom === "catalog") return { isReady: fixture.catalogReady };
      if (atom === "permission") return fixture.canWrite;
      if (atom.startsWith("shell:"))
        return { status: fixture.shellStatuses.get(atom.slice(6)) ?? "live" };
      if (atom.startsWith("layout:")) {
        const record =
          atom === "layout:" + environmentId
            ? fixture.record
            : fixture.otherRecords.get(atom.slice(7));
        return record == null ? AsyncResult.initial() : AsyncResult.success(record);
      }
      throw new Error("Unexpected atom: " + atom);
    },
  };
});
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    updateSidebarLayout: { permissionAtom: () => "permission" },
    sidebarLayout: ({ environmentId }: { environmentId: string }) => "layout:" + environmentId,
  },
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: (id: string) => "shell:" + id },
}));
vi.mock("../state/entities", () => ({
  useAllEnvironmentProjectSnapshotsReady: () =>
    environmentIds.every((id) => (fixture.shellStatuses.get(id) ?? "live") === "live"),
  useProjects: () => projects,
  useServerConfigs: () => configs,
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => environmentIds,
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => grouping,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => fixture.send,
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "config" ? { sidebarLayoutSync: true } : true),
  },
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let SidebarLayoutSync: typeof import("./SidebarLayoutSync").SidebarLayoutSync;
let store: typeof import("../uiStateStore");
let placement: typeof import("../projectSectionPlacement");
let renderer: ReactTestRenderer | undefined;
const displayKey = "t3code:sidebar-display:v1";
const other = EnvironmentId.make("client-d");
const savedLayout = {
  ...EMPTY_SIDEBAR_LAYOUT,
  sidebarProjectSections: [
    {
      id: JSON.stringify([environmentId, "saved"]),
      name: "Saved section",
      projectKeys: ["row"],
      collapsed: false,
      color: "blue" as const,
      folderIcons: true,
    },
  ],
};
const liveRecord: SidebarLayoutRecord = {
  revision: 1,
  legacyImportedAt: "2026-10-15T12:00:00Z",
  legacyImportId: null,
  layout: {
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [
      { id: "live", name: "Live section", projectKeys: [], collapsed: false },
    ],
  },
};
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map([
    [displayKey, JSON.stringify({ environmentIds: [environmentId, other], layout: savedLayout })],
  ]);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
  fixture.catalogReady = false;
  fixture.canWrite = true;
  fixture.record = null;
  fixture.shellStatuses.clear();
  projects = [];
  fixture.otherRecords.clear();
  fixture.send.mockReset();
  environmentIds = [environmentId, other];
  configs = new Map();
  store = await import("../uiStateStore");
  placement = await import("../projectSectionPlacement");
  ({ SidebarLayoutSync } = await import("./SidebarLayoutSync"));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(() => {
    fixture.version++;
    for (const listener of fixture.listeners) listener();
    if (renderer) renderer.update(<SidebarLayoutSync />);
    else renderer = create(<SidebarLayoutSync />);
  });
}
it("first render shows sections, colors and forced icons synchronously before configs or effects", async () => {
  const firstPaint: unknown[] = [];
  function Sidebar() {
    const sections = store.useUiStateStore((state) => state.sidebarProjectSections);
    firstPaint.push(sections);
    return (
      <div>
        {sections.map((section) => (
          <span key={section.id}>{section.name}</span>
        ))}
      </div>
    );
  }
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
  await act(() => {
    renderer = create(
      <>
        <Sidebar />
        <SidebarLayoutSync />
      </>,
    );
  });
  expect(firstPaint[0]).toEqual(savedLayout.sidebarProjectSections);
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
});
it("blocks expansion, movement, reorder and section placement until all environments are live", async () => {
  fixture.catalogReady = true;
  configs = new Map(environmentIds.map((id) => [id, { sidebarLayoutSync: true }]));
  await render();
  const state = store.useUiStateStore.getState();
  const sectionId = savedLayout.sidebarProjectSections[0]!.id;
  await act(() => {
    state.addSidebarProjectSection("New");
    state.renameSidebarProjectSection(sectionId, "Changed");
    state.setSidebarProjectSectionColor(sectionId, "red");
    state.setSidebarProjectSectionFolderIcons(sectionId, false);
    state.deleteSidebarProjectSection(sectionId);
    state.organizeSidebarSectionsByFolder(
      [{ projectKey: "row", workspaceRoots: ["/root/Work/repo"] }],
      "/root",
    );
    state.setSidebarProjectSectionExpanded(sectionId, false);
    state.setProjectExpanded("row", false);
    state.setSidebarOtherProjectsExpanded(false);
    state.moveProjectToSidebarProjectSection("row", sectionId);
    state.reorderSidebarProjectSections([sectionId]);
    state.reorderSidebarProjectSectionProjects(sectionId, ["row"]);
    state.reorderProjects(["row"], ["row"], ["other"]);
  });
  const localPlacement = vi.fn();
  placement.configureProjectSectionPlacement(localPlacement);
  expect(placement.sectionPlacementInput(environmentId, sectionId)).toBeNull();
  await placement.placeAddedProject({ environmentId, projectId: ProjectId.make("p") }, sectionId);
  placement.completeProjectSectionPlacement(
    { environmentId, projectId: ProjectId.make("p") },
    sectionId,
  );
  expect(localPlacement).not.toHaveBeenCalled();
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
  fixture.record = liveRecord;
  await render();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(fixture.send).not.toHaveBeenCalled();
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
  expect(JSON.parse(localStorage.getItem(displayKey)!).layout).toEqual(savedLayout);
  fixture.otherRecords.set(other, { ...liveRecord, layout: EMPTY_SIDEBAR_LAYOUT });
  await render();
  expect(store.useUiStateStore.getState().sidebarDisplaySnapshot).toBeNull();
  expect(store.useUiStateStore.getState().sidebarProjectSections.map((s) => s.name)).toEqual([
    "Live section",
  ]);
  expect(JSON.parse(localStorage.getItem(displayKey)!).environmentIds).toEqual(
    environmentIds.toSorted(),
  );
  await act(() =>
    store.useUiStateStore
      .getState()
      .setSidebarProjectSectionExpanded(JSON.stringify([environmentId, "live"]), false),
  );
  expect(store.useUiStateStore.getState().sidebarProjectSections[0]?.collapsed).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(fixture.send).toHaveBeenCalledTimes(1);
});
it.each(["empty", "cached", "synchronizing"] as const)(
  "keeps the display snapshot and its storage when layouts are live but remote projects are %s",
  async (status) => {
    fixture.catalogReady = true;
    configs = new Map(environmentIds.map((id) => [id, { sidebarLayoutSync: true }]));
    fixture.record = liveRecord;
    fixture.otherRecords.set(other, {
      ...liveRecord,
      layout: {
        ...liveRecord.layout,
        sidebarProjectSections: [
          { id: "remote", name: "Remote section", projectKeys: ["p"], collapsed: true },
        ],
        projectOrder: ["p"],
        projectExpandedById: { p: false },
      },
    });
    fixture.shellStatuses.set(other, status);
    const saved = localStorage.getItem(displayKey);
    await render();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(store.useUiStateStore.getState().sidebarDisplaySnapshot).not.toBeNull();
    expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
      savedLayout.sidebarProjectSections,
    );
    expect(localStorage.getItem(displayKey)).toBe(saved);
    expect(fixture.send).not.toHaveBeenCalled();

    projects = [
      {
        id: ProjectId.make("p"),
        environmentId: other,
        title: "Project",
        workspaceRoot: "/work/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-15T12:00:00Z",
        updatedAt: "2026-10-15T12:00:00Z",
      },
    ];
    fixture.shellStatuses.set(other, "live");
    await render();
    const state = store.useUiStateStore.getState();
    const key = other + ":/work/project";
    expect(state.sidebarDisplaySnapshot).toBeNull();
    expect(state.sidebarProjectSections).toContainEqual({
      id: JSON.stringify([other, "remote"]),
      name: "Remote section",
      projectKeys: [key],
      collapsed: true,
    });
    expect(state.projectOrder).toEqual([key]);
    expect(state.projectExpandedById[key]).toBe(false);
    expect(JSON.parse(localStorage.getItem(displayKey)!).layout).toMatchObject({
      sidebarProjectSections: state.sidebarProjectSections,
      projectOrder: [key],
      projectExpandedById: { [key]: false },
    });
    expect(fixture.send).not.toHaveBeenCalled();
  },
);
it("drops a mismatched environment set as soon as the catalog is known, before configs", async () => {
  environmentIds = [environmentId];
  await render();
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
  fixture.catalogReady = true;
  await render();
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual([]);
  expect(store.useUiStateStore.getState().sidebarDisplaySnapshot).toBeNull();
  expect(localStorage.getItem(displayKey)).toBeNull();
});
it("expires after 15 seconds and shows only the live part without extending the deadline", async () => {
  await render();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  fixture.catalogReady = true;
  configs = new Map(environmentIds.map((id) => [id, { sidebarLayoutSync: true }]));
  fixture.record = liveRecord;
  await render();
  await act(() => vi.advanceTimersByTimeAsync(4_999));
  expect(store.useUiStateStore.getState().sidebarProjectSections).toEqual(
    savedLayout.sidebarProjectSections,
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(store.useUiStateStore.getState().sidebarProjectSections.map((s) => s.name)).toEqual([
    "Live section",
  ]);
  expect(store.useUiStateStore.getState().sidebarDisplaySnapshot).toBeNull();
  expect(localStorage.getItem(displayKey)).toBeNull();
});
it("local-mode environments complete the live projection without a server record", async () => {
  fixture.catalogReady = true;
  configs = new Map([
    [environmentId, { sidebarLayoutSync: true }],
    [other, { sidebarLayoutSync: false }],
  ]);
  fixture.record = liveRecord;
  const localKey = "t3code:sidebar-local:" + other;
  localStorage.setItem(
    localKey,
    JSON.stringify({
      ...liveRecord.layout,
      sidebarProjectSections: [
        { id: "local", name: "Local only", projectKeys: [], collapsed: false },
      ],
    }),
  );
  const before = localStorage.getItem(localKey);
  await render();
  expect(store.useUiStateStore.getState().sidebarDisplaySnapshot).toBeNull();
  expect(store.useUiStateStore.getState().sidebarProjectSections.map((s) => s.name)).toEqual([
    "Live section",
    "Local only",
  ]);
  expect(localStorage.getItem(localKey)).toBe(before);
  expect(fixture.send).not.toHaveBeenCalled();
});
it("sync and legacy import do not read the display key or import its memberships", async () => {
  const getItem = vi.mocked(localStorage.getItem);
  getItem.mockClear();
  await render();
  expect(getItem.mock.calls.map(([key]) => key)).not.toContain(displayKey);
  fixture.catalogReady = true;
  configs = new Map(environmentIds.map((id) => [id, { sidebarLayoutSync: true }]));
  fixture.record = { ...liveRecord, legacyImportedAt: null, layout: EMPTY_SIDEBAR_LAYOUT };
  await render();
  expect(getItem.mock.calls.map(([key]) => key)).not.toContain(displayKey);
  expect(fixture.send).not.toHaveBeenCalled();
  const { readPendingSidebarImport } = await import("../sidebarLayoutMigration");
  expect(readPendingSidebarImport(environmentId)).toBeNull();
});
