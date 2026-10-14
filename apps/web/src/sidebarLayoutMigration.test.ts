import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { EMPTY_SIDEBAR_LAYOUT, EnvironmentId, type SidebarLayout } from "@t3tools/contracts";
import { applySidebarLayoutMutation } from "@t3tools/shared/sidebarLayout";
import {
  readPendingSidebarImport,
  savePendingSidebarImport,
  resolvePendingSidebarImport,
} from "./sidebarLayoutMigration";
afterEach(() => vi.unstubAllGlobals());
const env = EnvironmentId.make("local");
const candidate = {
  ...EMPTY_SIDEBAR_LAYOUT,
  sidebarProjectSections: [
    { id: "pending", name: "Pending", collapsed: false, projectKeys: ["clone"] },
  ],
  projectExpandedById: { clone: true },
};
describe("pending legacy sidebar aliases", () => {
  it("survives a reload, resolves membership despite already imported expansion, and stays environment scoped", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    savePendingSidebarImport(env, { importId: "winner", legacy: candidate, memberships: [] });
    expect(readPendingSidebarImport(EnvironmentId.make("remote"))).toBeNull();
    const saved = readPendingSidebarImport(env)!;
    const current: SidebarLayout = {
      ...EMPTY_SIDEBAR_LAYOUT,
      projectExpandedById: { clone: false },
    };
    const imported = new Set(saved.memberships);
    const operations = resolvePendingSidebarImport(saved.legacy, current, imported);
    const next = operations.reduce(
      (layout, operation) => applySidebarLayoutMutation(layout, operation)!,
      current,
    );
    expect(next.sidebarProjectSections[0]?.projectKeys).toEqual(["clone"]);
    expect(next.projectExpandedById.clone).toBe(false);
    expect(resolvePendingSidebarImport(candidate, next, imported)).toEqual([]);
    savePendingSidebarImport(env, null);
    expect(readPendingSidebarImport(env)).toBeNull();
  });
  it("keeps a project moved by the owner after the first import", () => {
    const current: SidebarLayout = {
      ...EMPTY_SIDEBAR_LAYOUT,
      sidebarProjectSections: [
        { id: "chosen", name: "Chosen", collapsed: false, projectKeys: ["clone"] },
      ],
    };
    const operations = resolvePendingSidebarImport(candidate, current, new Set());
    const next = operations.reduce(
      (layout, operation) => applySidebarLayoutMutation(layout, operation)!,
      current,
    );
    expect(
      next.sidebarProjectSections.find((section) => section.id === "chosen")?.projectKeys,
    ).toEqual(["clone"]);
  });
});
