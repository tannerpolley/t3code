import { describe, expect, it } from "vite-plus/test";

import { resolveProjectDrop, type ProjectDropSection } from "./SidebarProjectSections.logic";

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
