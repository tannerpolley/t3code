import { describe, expect, it } from "vite-plus/test";
import { threadLocation } from "./ThreadLocationIcon.logic";

describe("threadLocation", () => {
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
