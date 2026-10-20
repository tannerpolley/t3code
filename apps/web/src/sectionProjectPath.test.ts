import { describe, expect, it } from "vite-plus/test";

import {
  folderSubsectionInput,
  projectFolderNameProblem,
  sectionFolderPath,
} from "./sectionProjectPath";

describe("sectionFolderPath", () => {
  it("nests a subsection's folder inside its section's under the root", () => {
    expect(sectionFolderPath("/home/me/Workspaces/", ["Engineering"])).toBe(
      "/home/me/Workspaces/Engineering",
    );
    expect(sectionFolderPath("/home/me/Workspaces", ["Engineering", "IDAES"])).toBe(
      "/home/me/Workspaces/Engineering/IDAES",
    );
  });

  it("does not turn section labels into path traversal or extra folders", () => {
    expect(sectionFolderPath("/work", [".."])).toBeNull();
    expect(sectionFolderPath("/work", ["A/B"])).toBeNull();
    expect(sectionFolderPath("/", ["Work"])).toBe("/Work");
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

it("uses the selected folder basename and keeps its path after a rename or root setting change", () => {
  const folder = folderSubsectionInput("/engineering/IDAES/")!;
  expect(folder).toEqual({ name: "IDAES", folderPath: "/engineering/IDAES" });
  expect(sectionFolderPath("/different-root", ["Engineering", "Models"], folder.folderPath)).toBe(
    "/engineering/IDAES",
  );
  expect(sectionFolderPath("", ["Renamed"], folder.folderPath)).toBe("/engineering/IDAES");
  expect(folderSubsectionInput("C:\\Engineering\\IDAES\\")).toEqual({
    name: "IDAES",
    folderPath: "C:\\Engineering\\IDAES",
  });
  expect(folderSubsectionInput("/")).toBeNull();
  expect(folderSubsectionInput("C:\\")).toBeNull();
});
