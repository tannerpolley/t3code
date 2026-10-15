import { EMPTY_SIDEBAR_LAYOUT, EnvironmentId, type SidebarLayoutRecord } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ server: true }));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "config" ? { sidebarLayoutSync: fixture.server } : true),
  },
}));
vi.mock("./state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    updateSidebarLayout: { permissionAtom: () => "permission" },
  },
}));
import { createSidebarLayoutClient } from "./sidebarLayoutClient";
import { configureProjectSectionPlacement, sectionPlacementInput } from "./projectSectionPlacement";

const environmentId = EnvironmentId.make("server");
const sectionId = JSON.stringify([environmentId, "work"]);
const record: SidebarLayoutRecord = {
  revision: 1,
  legacyImportedAt: null,
  legacyImportId: null,
  layout: {
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [
      { id: "work", name: "Live folder", projectKeys: [], collapsed: false },
    ],
  },
};
afterEach(() => {
  configureProjectSectionPlacement(() => {});
  fixture.server = true;
});
it("blocks section placement until a live record contains that section", () => {
  const client = createSidebarLayoutClient(vi.fn(), vi.fn());
  client.configure(environmentId, true, record.layout);
  configureProjectSectionPlacement(vi.fn(), client);
  expect(sectionPlacementInput(environmentId, sectionId)).toBeNull();
  expect(sectionPlacementInput(environmentId, null)).toEqual({});
  client.receive(environmentId, record);
  expect(sectionPlacementInput(environmentId, sectionId)).toEqual({
    sectionId: "work",
    sidebarExpanded: true,
  });
  client.receive(environmentId, { ...record, revision: 2, layout: EMPTY_SIDEBAR_LAYOUT });
  expect(sectionPlacementInput(environmentId, sectionId)).toBeNull();
  client.dispose();
});
it("keeps local-mode placement available without a server record", () => {
  fixture.server = false;
  expect(sectionPlacementInput(environmentId, sectionId)).toEqual({});
});
