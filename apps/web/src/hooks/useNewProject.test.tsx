import { EMPTY_SIDEBAR_LAYOUT, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const createNew = vi.hoisted(() => vi.fn());
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "config" ? { sidebarLayoutSync: true } : true),
  },
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    updateSidebarLayout: { permissionAtom: () => "permission" },
  },
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { createNew: "create" } }));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: { publishRepository: "publish" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => createNew }));
vi.mock("~/state/entities", () => ({ waitForProject: async () => ({}) }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: vi.fn() },
}));

import { useNewProject } from "./useNewProject";
import { createSidebarLayoutClient } from "../sidebarLayoutClient";
import {
  configureProjectSectionPlacement,
  setAddProjectSection,
  useProjectSectionPlacementReady,
} from "../projectSectionPlacement";

afterEach(() => {
  configureProjectSectionPlacement(() => {});
  setAddProjectSection(null);
  vi.unstubAllGlobals();
});
it("sends no create RPC for a cached section, then allows placement after receive", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("server");
  const layout = {
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [{ id: "work", name: "Work", projectKeys: [], collapsed: false }],
  };
  const controller = createSidebarLayoutClient(vi.fn(), vi.fn());
  controller.configure(environmentId, true, layout);
  configureProjectSectionPlacement(vi.fn(), controller);
  setAddProjectSection(JSON.stringify([environmentId, "work"]));
  let createProject!: ReturnType<typeof useNewProject>;
  let placementReady = false;
  function Test() {
    const createProjectCallback = useNewProject();
    const ready = useProjectSectionPlacementReady(
      environmentId,
      JSON.stringify([environmentId, "work"]),
    );
    useEffect(() => {
      createProject = createProjectCallback;
      placementReady = ready;
    }, [createProjectCallback, ready]);
    return null;
  }
  const renderer = await act(() => create(<Test />));
  const input = { environmentId, name: "new-project", publishTo: null };
  expect(placementReady).toBe(false);
  expect(await createProject(input)).toBe(false);
  expect(createNew).not.toHaveBeenCalled();
  await act(() =>
    controller.receive(environmentId, {
      revision: 1,
      layout,
      legacyImportedAt: null,
      legacyImportId: null,
    }),
  );
  expect(placementReady).toBe(true);
  createNew.mockResolvedValue({
    _tag: "Success",
    value: { projectId: ProjectId.make("new"), workspaceRoot: "/work/new" },
  });
  expect(await createProject(input)).toBe(true);
  expect(createNew).toHaveBeenCalledWith({
    environmentId,
    input: { name: "new-project", sectionId: "work", sidebarExpanded: true },
  });
  await act(() => renderer.unmount());
  controller.dispose();
});
