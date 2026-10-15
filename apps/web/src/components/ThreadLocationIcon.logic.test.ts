import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
  it("names the main checkout or the worktree folder", () => {
    expect(
      threadLocation({ remote: false, environmentName: "Desktop", worktreePath: null }),
    ).toEqual({ kind: "local", label: "Local" });
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        worktreePath: "C:\\work\\feature\\",
      }),
    ).toEqual({ kind: "worktree", label: "Worktree feature" });
  });
  it("keeps the checkout kind elsewhere and names the environment, including cloud", () => {
    expect(
      threadLocation({ remote: true, environmentName: "Laptop", worktreePath: "/work/feature" }),
    ).toEqual({ kind: "worktree", label: "Laptop · Worktree feature" });
    expect(
      threadLocation({
        remote: false,
        machine: "cloud",
        environmentName: "Cloud",
        worktreePath: null,
      }),
    ).toEqual({ kind: "local", label: "Cloud · Local" });
  });
  it("marks a worktree while preparation has not bound its path", () => {
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        preparingWorktree: true,
        worktreePath: null,
      }),
    ).toEqual({ kind: "preparing", label: "Preparing worktree" });
    expect(
      threadLocation({
        remote: true,
        environmentName: "Laptop",
        preparingWorktree: true,
        worktreePath: null,
      }),
    ).toEqual({ kind: "preparing", label: "Laptop · Preparing worktree" });
    // A bound path wins over a stale preparing flag.
    expect(
      threadLocation({
        remote: false,
        environmentName: "Desktop",
        preparingWorktree: true,
        worktreePath: "/work/feature",
      }),
    ).toEqual({ kind: "worktree", label: "Worktree feature" });
  });
});
