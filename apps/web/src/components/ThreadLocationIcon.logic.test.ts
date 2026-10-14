import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
  it("uses the machine icon for cloud even in the primary environment", () => {
    expect(
      threadLocation({
        remote: false,
        machine: "cloud",
        environmentName: "Cloud",
        worktreePath: null,
      }),
    ).toEqual({ kind: "environment", label: "Cloud" });
    expect(
      threadLocation({
        remote: true,
        machine: "desktop",
        environmentName: "Laptop",
        worktreePath: null,
      }),
    ).toEqual({ kind: "environment", label: "Laptop" });
  });
  it("marks a worktree while preparation has not bound its path", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        preparingWorktree: true,
        worktreePath: null,
      }),
    ).toEqual({ kind: "worktree", label: "Preparing worktree" });
  });
  it("marks checkouts, worktrees and remote worktrees with their location", () => {
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: null }),
    ).toEqual({ kind: "checkout", label: "Desktop" });
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: "/work/feature/" }),
    ).toEqual({ kind: "worktree", label: "Worktree: feature" });
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "C:\\work\\feature",
      }),
    ).toEqual({ kind: "worktree", label: "Worktree: feature" });
    expect(
      threadLocation({ remote: true, environmentName: "Cloud", worktreePath: "/work/feature" }),
    ).toEqual({ kind: "environment", label: "Cloud" });
  });
});
