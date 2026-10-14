import { describe, expect, it } from "vite-plus/test";
import {
  sectionPlacementInput,
  currentAddProjectSection,
  setAddProjectSection,
} from "./projectSectionPlacement";
describe("section placement input", () => {
  it("places a project by its environment and section, without waiting for repository identity", () => {
    expect(sectionPlacementInput("local", JSON.stringify(["local", "apps"]))).toEqual({
      sectionId: "apps",
      sidebarExpanded: true,
    });
    expect(sectionPlacementInput("remote", JSON.stringify(["local", "apps"]))).toEqual({});
    expect(sectionPlacementInput("local", null)).toEqual({});
  });
  it("keeps section intent only for the open add flow", () => {
    setAddProjectSection("apps");
    expect(currentAddProjectSection()).toBe("apps");
    setAddProjectSection(null);
    expect(currentAddProjectSection()).toBeNull();
  });
});
