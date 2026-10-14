import { EMPTY_SIDEBAR_LAYOUT, EnvironmentId, type SidebarLayoutRecord } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
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
  await act(() => {
    useUiStateStore.getState().renameSidebarProjectSection(sectionId, "Unauthorized rename");
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(useUiStateStore.getState().sidebarProjectSections[0]?.name).toBe("Shared empty section");
  fixture.record = record(2, true);
  await render();
  expect(useUiStateStore.getState().sidebarProjectSections[0]?.collapsed).toBe(true);
  expect(fixture.send).not.toHaveBeenCalled();
});
