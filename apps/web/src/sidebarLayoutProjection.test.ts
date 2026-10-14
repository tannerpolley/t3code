import { describe, expect, it } from "vite-plus/test";
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
      [],
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
