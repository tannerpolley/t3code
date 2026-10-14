import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SIDEBAR_LAYOUT,
  EnvironmentId,
  ProjectId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { Project } from "./types";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import { derivePhysicalProjectKey } from "./logicalProject";
import {
  migrateSidebarLayout,
  projectSidebarLayout,
  sidebarSectionKey,
} from "./sidebarLayoutProjection";
import { createLegacySidebarRetirement } from "./sidebarLayoutMigration";
import { createSidebarLayoutClient, readLocalSidebarLayout } from "./sidebarLayoutClient";
import { clearLegacySidebarLayout, PERSISTED_STATE_KEY, parsePersistedState } from "./uiStateStore";
afterEach(() => vi.unstubAllGlobals());
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const project = (
  id: string,
  environmentId = local,
  identity: Project["repositoryIdentity"] = null,
): Project => ({
  id: ProjectId.make(id),
  environmentId,
  title: id,
  workspaceRoot: "/work/" + id,
  repositoryIdentity: identity,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
});
const identity = {
  canonicalKey: "github.com/me/app",
  rootPath: "/work/clone",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/me/app.git",
  },
};
const groups = (projects: readonly Project[], mode: SidebarProjectGroupingMode = "repository") =>
  buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: mode, sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: local,
    resolveEnvironmentLabel: () => null,
  });
const layout = {
  ...EMPTY_SIDEBAR_LAYOUT,
  sidebarProjectSections: [{ id: "work", name: "Work", projectKeys: ["clone"], collapsed: false }],
  projectExpandedById: { clone: false },
};

describe("shared sidebar projection", () => {
  it("keeps an unavailable environment's legacy sections across reload and saves fallback before any edit", () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    const readLegacy = () =>
      parsePersistedState(JSON.parse(localStorage.getItem(PERSISTED_STATE_KEY) ?? "{}"));
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });
    const legacy = {
      ...EMPTY_SIDEBAR_LAYOUT,
      sidebarProjectSections: [
        { id: "work", name: "Work", collapsed: true, projectKeys: ["clone", "remote-project"] },
      ],
      projectExpandedById: { "remote-project": false },
    };
    localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(legacy));
    const retire = createLegacySidebarRetirement(clearLegacySidebarLayout);
    // Only the local environment imported; the remote server has no config or shell yet.
    retire(local, [local, remote]);
    expect(readLegacy().sidebarProjectSections).toEqual(legacy.sidebarProjectSections);
    const candidate = migrateSidebarLayout(
      readLegacy(),
      groups([project("remote-project", remote)]),
      remote,
    );
    const send = vi.fn();
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(remote, false, EMPTY_SIDEBAR_LAYOUT, { fallbackReady: false });
    expect(storage.has("t3code:sidebar-local:" + remote)).toBe(false);
    client.configure(remote, false, candidate);
    retire(remote, [local, remote]);
    expect(readLegacy().sidebarProjectSections).toEqual([]);
    client.dispose();
    const reloaded = createSidebarLayoutClient(send, vi.fn());
    reloaded.configure(remote, false, EMPTY_SIDEBAR_LAYOUT);
    expect(reloaded.layouts([remote]).get(remote)?.sidebarProjectSections).toEqual([
      { ...legacy.sidebarProjectSections[0]!, projectKeys: ["remote-project"] },
    ]);
    expect(reloaded.layouts([remote]).get(remote)?.projectExpandedById).toEqual({
      "remote-project": false,
    });
    expect(send).not.toHaveBeenCalled();
    // A later capability/permission upgrade can import the persisted fallback
    // even after the shared legacy source has been retired.
    expect(
      migrateSidebarLayout(
        readLocalSidebarLayout(remote, readLegacy()),
        groups([project("remote-project", remote)]),
        remote,
      ),
    ).toEqual(candidate);
    reloaded.dispose();
  });
  it("imports only each environment's projects and necessary section ancestors", () => {
    const snapshot = groups([project("clone"), project("remote-project", remote)]);
    const legacy = {
      ...EMPTY_SIDEBAR_LAYOUT,
      sidebarProjectSections: [
        { id: "local-only", name: "Local", collapsed: false, projectKeys: ["clone"] },
        { id: "remote-only", name: "Remote", collapsed: false, projectKeys: ["remote-project"] },
        { id: "empty", name: "Empty", collapsed: false, projectKeys: [] },
      ],
    };
    expect(
      migrateSidebarLayout(legacy, snapshot, local).sidebarProjectSections.map((s) => s.id),
    ).toEqual(["local-only"]);
    expect(
      migrateSidebarLayout(legacy, snapshot, remote).sidebarProjectSections.map((s) => s.id),
    ).toEqual(["remote-only"]);
    expect(
      migrateSidebarLayout(legacy, snapshot, EnvironmentId.make("third")).sidebarProjectSections,
    ).toEqual([]);
  });
  it("resolves available ID keys before identity, retaining unresolved aliases for later projection", () => {
    const before = groups([project("clone")]);
    const after = groups([project("clone", local, identity)]);
    const legacy = {
      ...EMPTY_SIDEBAR_LAYOUT,
      sidebarProjectSections: [
        { id: "known", name: "Known", collapsed: false, projectKeys: ["clone"] },
        { id: "pending", name: "Pending", collapsed: false, projectKeys: [after[0]!.projectKey] },
      ],
    };
    expect(
      migrateSidebarLayout(legacy, before, local).sidebarProjectSections.map((s) => s.id),
    ).toEqual(["known"]);
    const unresolved = { ...legacy, sidebarProjectSections: [legacy.sidebarProjectSections[1]!] };
    expect(migrateSidebarLayout(unresolved, before, local).sidebarProjectSections).toEqual([]);
    expect(
      migrateSidebarLayout(unresolved, after, local).sidebarProjectSections[0]?.projectKeys,
    ).toEqual(["clone"]);
  });
  it("keeps clone membership and expansion as its row gains repository identity", () => {
    const before = groups([project("clone")]);
    const after = groups([project("clone", local, identity)]);
    expect(before[0]!.projectKey).not.toBe(after[0]!.projectKey);
    for (const snapshot of [before, after]) {
      const projected = projectSidebarLayout({
        layouts: new Map([[local, layout]]),
        groups: snapshot,
        primaryEnvironmentId: local,
      });
      expect(projected.sidebarProjectSections[0]!.projectKeys).toEqual([snapshot[0]!.projectKey]);
      expect(projected.projectExpandedById[snapshot[0]!.projectKey]).toBe(false);
    }
    expect(layout.sidebarProjectSections[0]!.projectKeys).toEqual(["clone"]);
  });
  it("holds grouped rows and splits them according to the client's grouping choice", () => {
    const projects = [
      project("clone", local, identity),
      project("copy", local, { ...identity, rootPath: "/work/copy" }),
    ];
    const saved = {
      ...layout,
      sidebarProjectSections: [
        { ...layout.sidebarProjectSections[0]!, projectKeys: ["clone", "copy"] },
      ],
    };
    const joined = groups(projects);
    const separate = groups(projects, "separate");
    expect(joined).toHaveLength(1);
    expect(
      projectSidebarLayout({
        layouts: new Map([[local, saved]]),
        groups: joined,
        primaryEnvironmentId: local,
      }).sidebarProjectSections[0]!.projectKeys,
    ).toHaveLength(1);
    expect(
      projectSidebarLayout({
        layouts: new Map([[local, saved]]),
        groups: separate,
        primaryEnvironmentId: local,
      }).sidebarProjectSections[0]!.projectKeys,
    ).toHaveLength(2);
  });
  it("isolates identical section and project IDs on two environments", () => {
    const snapshot = groups([project("clone"), project("clone", remote)], "separate");
    const projected = projectSidebarLayout({
      layouts: new Map([
        [local, layout],
        [remote, layout],
      ]),
      groups: snapshot,
      primaryEnvironmentId: local,
    });
    expect(projected.sidebarProjectSections.map((section) => section.id)).toEqual([
      sidebarSectionKey(local, "work"),
      sidebarSectionKey(remote, "work"),
    ]);
    expect(
      new Set(projected.sidebarProjectSections.flatMap((section) => section.projectKeys)).size,
    ).toBe(2);
  });
  it("migrates saved grouping aliases even before local grouping preferences hydrate", () => {
    const member = { ...project("clone", local, identity), workspaceRoot: "/work/clone/subdir" };
    const previous = groups([member], "repository_path");
    const current = groups([member], "repository");
    expect(previous[0]!.projectKey).not.toBe(current[0]!.projectKey);
    const legacy = {
      ...layout,
      sidebarProjectSections: [
        { ...layout.sidebarProjectSections[0]!, projectKeys: [previous[0]!.projectKey] },
        {
          id: "duplicate-alias",
          name: "Duplicate",
          collapsed: false,
          projectKeys: [derivePhysicalProjectKey(member)],
        },
      ],
      projectExpandedById: { "legacy-project-expansion-default": false },
    };
    const migrated = migrateSidebarLayout(legacy, current, local);
    expect(migrated.sidebarProjectSections.map((section) => section.projectKeys)).toEqual([
      ["clone"],
    ]);
    expect(migrated.projectExpandedById).toEqual({ clone: false });
  });
  it("migrates logical and path preferences into every member's stable ID only on its environment", () => {
    const projects = [
      project("clone", local, identity),
      project("copy", remote, { ...identity, rootPath: "/work/copy" }),
    ];
    const snapshot = groups(projects);
    const key = snapshot[0]!.projectKey;
    const legacy = {
      ...layout,
      sidebarProjectSections: [{ ...layout.sidebarProjectSections[0]!, projectKeys: [key] }],
      projectExpandedById: { [key]: false },
      projectOrder: projects.map(derivePhysicalProjectKey),
    };
    expect(migrateSidebarLayout(legacy, snapshot, local)).toMatchObject({
      sidebarProjectSections: [{ projectKeys: ["clone"] }],
      projectExpandedById: { clone: false },
      projectOrder: ["clone"],
    });
    expect(migrateSidebarLayout(legacy, snapshot, remote)).toMatchObject({
      sidebarProjectSections: [{ projectKeys: ["copy"] }],
      projectExpandedById: { copy: false },
      projectOrder: ["copy"],
    });
  });
});
