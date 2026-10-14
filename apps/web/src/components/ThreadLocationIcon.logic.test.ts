import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
  it("names the main checkout or the worktree, then the branch", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: null,
        branch: "main",
      }),
    ).toEqual({ kind: "checkout", label: "Local · main" });
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "C:\\work\\feature\\",
        branch: "t3/feature",
      }),
    ).toEqual({ kind: "worktree", label: "Worktree feature · t3/feature" });
    // An unknown branch leaves the location alone.
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: "/work/feature" }),
    ).toEqual({ kind: "worktree", label: "Worktree feature" });
  });
  it("leads with the environment elsewhere, including cloud in the primary environment", () => {
    expect(
      threadLocation({
        remote: true,
        environmentName: "Laptop",
        worktreePath: "/work/feature",
        branch: "t3/feature",
      }),
    ).toEqual({ kind: "environment", label: "Laptop · Worktree feature · t3/feature" });
    expect(
      threadLocation({
        remote: false,
        machine: "cloud",
        environmentName: "Cloud",
        worktreePath: null,
        branch: "main",
      }),
    ).toEqual({ kind: "environment", label: "Cloud · Local · main" });
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
    ).toEqual({ kind: "worktree", label: "Preparing worktree" });
  });
});
