import { describe, expect, it } from "vite-plus/test";

import { organizeSectionsByFolder } from "./sidebarSectionFolders";
import type { SidebarProjectSection } from "./uiStateStore";

const ROOT = "/home/me/Workspaces";

function organize(
  projects: Array<[string, string]>,
  sections: SidebarProjectSection[] = [],
): SidebarProjectSection[] {
  let next = 0;
  return organizeSectionsByFolder({
    sections,
    projects: projects.map(([projectKey, path]) => ({ projectKey, workspaceRoots: [path] })),
    root: `${ROOT}/`,
    makeId: () => `new-${++next}`,
  });
}

const shape = (sections: SidebarProjectSection[]) =>
  sections.map(({ name, parentId, projectKeys }) => ({ name, parentId, projectKeys }));

describe("organizeSectionsByFolder", () => {
  it("builds sections and subsections from the folders above each project", () => {
    expect(
      shape(
        organize([
          ["t3code", `${ROOT}/Applications/t3code`],
          ["pyomo", `${ROOT}/Engineering/IDAES/pyomo`],
          ["mea", `${ROOT}/Engineering/MEA-Thermodynamics`],
          ["deep", `${ROOT}/Engineering/IDAES/examples/nested/deep`],
        ]),
      ),
    ).toEqual([
      { name: "Applications", parentId: undefined, projectKeys: ["t3code"] },
      { name: "Engineering", parentId: undefined, projectKeys: ["mea"] },
      { name: "IDAES", parentId: "new-2", projectKeys: ["pyomo", "deep"] },
    ]);
  });

  it("keeps a superproject's submodules with it, and leaves projects outside the tree alone", () => {
    const existing: SidebarProjectSection = {
      id: "keep",
      name: "Mine",
      projectKeys: ["elsewhere", "loose"],
      collapsed: true,
    };
    const result = organize(
      [
        ["cse", `${ROOT}/Agentic-Coding/plugins/cse`],
        ["cse-sub", `${ROOT}/Agentic-Coding/plugins/cse/vendor/lib`],
        ["elsewhere", "/tmp/elsewhere"],
        ["loose", `${ROOT}/loose`],
      ],
      [existing],
    );
    expect(shape(result)).toEqual([
      { name: "Mine", parentId: undefined, projectKeys: ["elsewhere", "loose"] },
      { name: "Agentic-Coding", parentId: undefined, projectKeys: [] },
      { name: "plugins", parentId: "new-1", projectKeys: ["cse", "cse-sub"] },
    ]);
  });

  it("reuses sections by name and moves only what changed on a second run", () => {
    const first = organize([
      ["a", `${ROOT}/Applications/a`],
      ["b", `${ROOT}/Applications/b`],
    ]);
    const reordered = first.map((section) => ({ ...section, projectKeys: ["b", "a"] }));
    const second = organize(
      [
        ["a", `${ROOT}/applications/a`],
        ["b", `${ROOT}/Applications/b`],
      ],
      reordered,
    );
    expect(second.map((section) => section.id)).toEqual(first.map((section) => section.id));
    expect(second[0]?.projectKeys).toEqual(["b", "a"]);
  });
});
