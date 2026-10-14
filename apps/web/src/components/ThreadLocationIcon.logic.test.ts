import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
  it("names the environment and folder for cloud even in the primary environment", () => {
    expect(
      threadLocation({
        remote: false,
        machine: "cloud",
        environmentName: "Cloud",
        worktreePath: null,
        projectRoot: "/work/aurora-web",
        branch: "main",
      }),
    ).toEqual({ kind: "environment", label: "Cloud · aurora-web" });
    expect(
      threadLocation({
        remote: true,
        machine: "desktop",
        environmentName: "Laptop",
        worktreePath: "/work/feature",
      }),
    ).toEqual({ kind: "environment", label: "Laptop · feature (worktree)" });
  });
  it("marks a worktree while preparation has not bound its path", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        preparingWorktree: true,
        worktreePath: null,
        projectRoot: "/work/aurora-web",
        branch: "feature",
      }),
    ).toEqual({ kind: "worktree", label: "Preparing worktree" });
  });
  it("names the local folder and branch of checkouts and worktrees", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: null,
        projectRoot: "/work/aurora-web/",
        branch: "main",
      }),
    ).toEqual({ kind: "checkout", label: "aurora-web · main" });
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "C:\\work\\feature",
        projectRoot: "C:\\work\\aurora-web",
        branch: "t3/feature",
      }),
    ).toEqual({ kind: "worktree", label: "feature (worktree) · t3/feature" });
    // An unknown branch leaves the folder; an unknown project leaves the environment.
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "/work/feature/",
        branch: null,
      }),
    ).toEqual({ kind: "worktree", label: "feature (worktree)" });
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: null }),
    ).toEqual({ kind: "checkout", label: "Desktop" });
  });
});
