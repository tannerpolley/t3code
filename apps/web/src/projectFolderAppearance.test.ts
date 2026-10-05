import { describe, expect, it } from "vite-plus/test";
import { resolveProjectFolderAppearance } from "./projectFolderAppearance";
import type { SidebarProjectSection } from "./uiStateStore";

describe("resolveProjectFolderAppearance", () => {
  it("inherits a parent section's tint and folder choice", () => {
    const sections: SidebarProjectSection[] = [
      {
        id: "work",
        name: "Work",
        projectKeys: [],
        collapsed: false,
        color: "blue",
        folderIcons: true,
      },
      {
        id: "client",
        name: "Client",
        projectKeys: ["project-a"],
        collapsed: false,
        parentId: "work",
      },
    ];

    expect(resolveProjectFolderAppearance("project-a", sections, true)).toEqual({
      folderColor: "blue",
      forceFolder: true,
    });
    expect(resolveProjectFolderAppearance("project-a", sections, false)).toEqual({
      folderColor: undefined,
      forceFolder: true,
    });
  });
});
