import {
  EMPTY_SIDEBAR_LAYOUT,
  EnvironmentId,
  type SidebarLayoutRecord,
  type SidebarLayoutUpdate,
} from "@t3tools/contracts";
import { applySidebarLayoutMutation } from "@t3tools/shared/sidebarLayout";
import { AsyncResult } from "effect/reactivity";
// oxlint-disable-next-line t3code/require-disposable-render -- react-test-renderer unit test without a browser
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  canWrite: true,
  record: null as SidebarLayoutRecord | null,
  send: vi.fn(),
  version: 0,
  listeners: new Set<() => void>(),
}));
const environmentId = EnvironmentId.make("client-c");
const environmentIds = [environmentId];
const projects: [] = [];
const configs = new Map([[environmentId, { sidebarLayoutSync: true }]]);
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
      if (atom === "catalog") return { isReady: true };
      if (atom === "permission") return fixture.canWrite;
      if (atom === "shell") return { status: "live" };
      if (atom === "layout")
        return fixture.record === null
          ? AsyncResult.initial()
          : AsyncResult.success(fixture.record);
      throw new Error("Unexpected atom: " + atom);
    },
  };
});
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    updateSidebarLayout: { permissionAtom: () => "permission" },
    sidebarLayout: () => "layout",
  },
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: () => "shell" },
}));
vi.mock("../state/entities", () => ({
  useAllEnvironmentProjectSnapshotsReady: () => true,
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
vi.mock("../projectSectionPlacement", () => ({
  configureProjectSectionPlacement: vi.fn(),
  sectionTarget: () => null,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { SidebarLayoutSync } from "./SidebarLayoutSync";
import { SIDEBAR_WRITE_DELAY } from "../sidebarLayoutClient";
import { useUiStateStore } from "../uiStateStore";

let renderer: ReactTestRenderer | undefined;
const record = (revision: number, collapsed = false): SidebarLayoutRecord => ({
  revision,
  legacyImportedAt: null,
  legacyImportId: null,
  layout: {
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [
      { id: "empty", name: "Shared empty section", projectKeys: [], collapsed },
    ],
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  // oxlint-disable-next-line t3code/require-disposable-render -- react-test-renderer unit test without a browser
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { localStorage });
  fixture.canWrite = true;
  fixture.send.mockReset();
  fixture.record = record(1);
  useUiStateStore.setState({
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [],
    projectOrder: [],
  });
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
it.each([false, true])(
  "client C with no legacy layout applies the server layout, including an empty section, and receives live updates (snapshot after mount: %s)",
  async (afterMount) => {
    if (afterMount) {
      fixture.record = null;
      await render();
      fixture.record = record(1);
    }
    await render();
    expect(useUiStateStore.getState().sidebarProjectSections).toMatchObject([
      { name: "Shared empty section", projectKeys: [], collapsed: false },
    ]);
    fixture.record = record(2, true);
    await render();
    expect(useUiStateStore.getState().sidebarProjectSections[0]?.collapsed).toBe(true);
    fixture.record = {
      ...record(3),
      layout: { ...EMPTY_SIDEBAR_LAYOUT, sidebarProjectSections: [] },
    };
    await render();
    expect(useUiStateStore.getState().sidebarProjectSections).toEqual([]);
    expect(fixture.send).not.toHaveBeenCalled();
  },
);
it("a read-only client sees the shared layout and live updates without submitting edits or imports", async () => {
  fixture.canWrite = false;
  await render();
  expect(useUiStateStore.getState().sidebarProjectSections[0]?.name).toBe("Shared empty section");
  const sectionId = useUiStateStore.getState().sidebarProjectSections[0]!.id;
  await act(async () => {
    expect(
      await useUiStateStore.getState().addSidebarProjectSection("Unauthorized add"),
    ).toBeNull();
    useUiStateStore.getState().renameSidebarProjectSection(sectionId, "Unauthorized rename");
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(useUiStateStore.getState().sidebarProjectSections[0]?.name).toBe("Shared empty section");
  fixture.record = record(2, true);
  await render();
  expect(useUiStateStore.getState().sidebarProjectSections[0]?.collapsed).toBe(true);
  expect(fixture.send).not.toHaveBeenCalled();
});

it.each([true, false])(
  "reports whether a queued subsection was saved when the parent is deleted before the write: %s",
  async (parentDeleted) => {
    await render();
    const parentId = useUiStateStore.getState().sidebarProjectSections[0]!.id;
    fixture.send.mockImplementation(async ({ input }: { input: SidebarLayoutUpdate }) =>
      AsyncResult.success({
        ...record(2),
        layout: input.operations.reduce(
          (layout, operation) => applySidebarLayoutMutation(layout, operation) ?? layout,
          parentDeleted ? EMPTY_SIDEBAR_LAYOUT : record(1).layout,
        ),
      }),
    );
    const result = vi.fn();
    await act(() => {
      void useUiStateStore
        .getState()
        .addSidebarProjectSection("Subsection", parentId, "/work/Subsection")
        .then(result);
    });
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY));
    expect(result).toHaveBeenCalledWith(parentDeleted ? null : expect.any(String));
  },
);
