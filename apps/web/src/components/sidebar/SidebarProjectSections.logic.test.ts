import { describe, expect, it } from "vite-plus/test";

import {
  collectVisibleProjectThreadOrder,
  resolveProjectDrop,
  type ProjectDropSection,
  type ProjectThreadSection,
} from "./SidebarProjectSections.logic";

const sections: ProjectDropSection[] = [
  { id: "work", custom: true, projectKeys: ["a", "b", "c"] },
  { id: "apps", custom: true, projectKeys: ["x", "y"] },
  { id: "__ungrouped__", custom: false, projectKeys: ["u"] },
];

const drop = (projectKey: string, over: Parameters<typeof resolveProjectDrop>[0]["over"]) =>
  resolveProjectDrop({ projectKey, over, sections });

describe("resolveProjectDrop", () => {
  it("reorders within a section, landing below the row when moving down", () => {
    expect(drop("a", { type: "project", projectKey: "c" })).toEqual({
      sectionId: "work",
      projectKeys: ["b", "c", "a"],
      beforeKey: null,
    });
    expect(drop("c", { type: "project", projectKey: "a" })).toEqual({
      sectionId: "work",
      projectKeys: ["c", "a", "b"],
      beforeKey: "a",
    });
  });

  it("inserts above the hovered project of another section, or at its end", () => {
    expect(drop("a", { type: "project", projectKey: "y" })).toEqual({
      sectionId: "apps",
      projectKeys: ["x", "a", "y"],
      beforeKey: "y",
    });
    expect(drop("a", { type: "section", sectionId: "apps" })).toEqual({
      sectionId: "apps",
      projectKeys: ["x", "y", "a"],
      beforeKey: null,
    });
    expect(drop("u", { type: "project", projectKey: "x" })?.projectKeys).toEqual(["u", "x", "y"]);
  });

  it("moves into Other projects without a line, since that section has no order", () => {
    expect(drop("a", { type: "project", projectKey: "u" })).toEqual({
      sectionId: "__ungrouped__",
      projectKeys: null,
      beforeKey: undefined,
    });
  });

  it("is a no-op when the project would stay where it is", () => {
    expect(drop("a", { type: "project", projectKey: "a" })).toBeNull();
    expect(drop("c", { type: "section", sectionId: "work" })).toBeNull();
    expect(drop("u", { type: "section", sectionId: "__ungrouped__" })).toBeNull();
    expect(drop("a", { type: "section", sectionId: "missing" })).toBeNull();
  });
});

describe("collectVisibleProjectThreadOrder", () => {
  it("follows visible subsection, project, and Other projects row order", () => {
    const projects = ["a", "b", "c", "other"].map((projectKey) => ({ projectKey }));
    const sections: ProjectThreadSection[] = [
      { id: "work", projectKeys: ["a", "b"], collapsed: false },
      { id: "client", parentId: "work", projectKeys: ["c"], collapsed: false },
    ];
    const threadsByProjectKey = new Map([
      ["a", [{ key: "a-1" }, { key: "a-2" }]],
      ["b", [{ key: "b-1" }]],
      ["c", [{ key: "c-1" }]],
      ["other", [{ key: "other-1" }]],
    ]);

    const collect = (
      options: {
        readonly sections?: readonly ProjectThreadSection[];
        readonly otherProjectsExpanded?: boolean;
        readonly expandedProjectKeys?: readonly string[];
      } = {},
    ) =>
      collectVisibleProjectThreadOrder({
        projects,
        sections: options.sections ?? sections,
        otherProjectsExpanded: options.otherProjectsExpanded ?? true,
        isProjectExpanded: (key) => options.expandedProjectKeys?.includes(key) ?? true,
        threadsByProjectKey,
        getThreadKey: (thread) => thread.key,
      });

    expect(collect()).toEqual(["c-1", "a-1", "a-2", "b-1", "other-1"]);
    expect(collect({ expandedProjectKeys: ["a", "c", "other"] })).toEqual([
      "c-1",
      "a-1",
      "a-2",
      "other-1",
    ]);
    expect(
      collect({
        sections: sections.map((section) =>
          section.id === "work" ? { ...section, collapsed: true } : section,
        ),
        otherProjectsExpanded: false,
      }),
    ).toEqual([]);
  });
});
