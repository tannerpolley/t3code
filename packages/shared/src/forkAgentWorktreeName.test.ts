import { describe, expect, it } from "vite-plus/test";
import { agentWorktreeName } from "./git.ts";

describe("agentWorktreeName", () => {
  it("names issue work after the issue with a short title slug", () => {
    expect(agentWorktreeName("Fix: the `Sidebar` / folders!", 42)).toBe(
      "issue-42-fix-the-sidebar-folders",
    );
    expect(agentWorktreeName("   ", 478)).toBe("issue-478");
  });

  it("slugs other titles at a word boundary without a prefix or id", () => {
    expect(
      agentWorktreeName("Make the worktree folders plain and readable for every agent launch"),
    ).toBe("make-the-worktree-folders-plain-and");
    expect(agentWorktreeName("x".repeat(60))).toBe("x".repeat(40));
  });
});
