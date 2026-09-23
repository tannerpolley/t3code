import { describe, expect, it } from "vite-plus/test";

import { projectFolderNameProblem, sectionFolderPath } from "./sectionProjectPath";

describe("sectionFolderPath", () => {
  it("nests a subsection's folder inside its section's under the root", () => {
    expect(sectionFolderPath("/home/me/Workspaces/", ["Engineering"])).toBe(
      "/home/me/Workspaces/Engineering",
    );
    expect(sectionFolderPath("/home/me/Workspaces", ["Engineering", "IDAES"])).toBe(
      "/home/me/Workspaces/Engineering/IDAES",
    );
  });

  it("needs a full root path", () => {
    expect(sectionFolderPath("", ["Engineering"])).toBeNull();
    expect(sectionFolderPath("~/Workspaces", ["Engineering"])).toBeNull();
  });
});

describe("projectFolderNameProblem", () => {
  it("accepts a plain folder name and rejects empty, dot and slashed names", () => {
    expect(projectFolderNameProblem(" new-model ")).toBeNull();
    expect(projectFolderNameProblem("  ")).not.toBeNull();
    expect(projectFolderNameProblem("..")).not.toBeNull();
    expect(projectFolderNameProblem("a/b")).not.toBeNull();
  });
});
