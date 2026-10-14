import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
  it("names the main checkout or the worktree folder, then the branch", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: null,
        branch: "main",
      }),
    ).toEqual({
      kind: "local",
      environment: null,
      checkout: "Local",
      branch: "main",
      label: "Local · main",
    });
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "C:\\work\\feature\\",
        branch: "t3/feature",
      }),
    ).toEqual({
      kind: "worktree",
      environment: null,
      checkout: "feature",
      branch: "t3/feature",
      label: "Worktree feature · t3/feature",
    });
    // An unknown branch leaves the location alone.
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: "/work/feature" }),
    ).toMatchObject({ kind: "worktree", branch: null, label: "Worktree feature" });
  });
  it("keeps the checkout kind elsewhere and names the environment, including cloud", () => {
    expect(
      threadLocation({
        remote: true,
        environmentName: "Laptop",
        worktreePath: "/work/feature",
        branch: "t3/feature",
      }),
    ).toMatchObject({
      kind: "worktree",
      environment: "Laptop",
      checkout: "feature",
      label: "Laptop · Worktree feature · t3/feature",
    });
    expect(
      threadLocation({
        remote: false,
        machine: "cloud",
        environmentName: "Cloud",
        worktreePath: null,
        branch: "main",
      }),
    ).toMatchObject({ kind: "local", environment: "Cloud", label: "Cloud · Local · main" });
  });
  it("marks a worktree while preparation has not bound its path", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        preparingWorktree: true,
        worktreePath: null,
        branch: "t3/feature",
      }),
    ).toMatchObject({ kind: "preparing", checkout: "Preparing worktree", branch: "t3/feature" });
  });
});
