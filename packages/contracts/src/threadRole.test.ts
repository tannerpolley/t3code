import { describe, expect, it } from "@effect/vitest";

import { effectiveThreadRole, nativeSubagentRole } from "./threadRole.ts";

describe("nativeSubagentRole", () => {
  it.each([
    // Claude subagent_type values
    ["worker", "implementor"],
    ["sol-advisor-implementer", "implementor"],
    ["thorough-builder", "implementor"],
    ["coder", "implementor"],
    ["reviewer", "reviewer"],
    ["final-reviewer", "reviewer"],
    ["Explore", "investigator"],
    ["fast-explorer", "investigator"],
    ["researcher", "investigator"],
    ["investigator", "investigator"],
    ["web-search", "investigator"],
    ["tester", "checker"],
    ["checker", "checker"],
    ["verifier", "checker"],
    // Codex agent roles
    ["sol_advisor_reviewer", "reviewer"],
    // A specific word outranks a generic one.
    ["codereviewer", "reviewer"],
    ["implementation-checker", "checker"],
    ["research-worker", "investigator"],
    // Provider default agents match whole and case-insensitively.
    ["manager", "orchestrator"],
    ["Manager", "orchestrator"],
    ["default", "implementor"],
    ["general-purpose", "implementor"],
    ["General-Purpose", "implementor"],
    ["task-manager", "implementor"],
    ["default-reviewer", "reviewer"],
    // Other named types are Implementors; a missing type stays open for a later frame.
    ["Plan", "implementor"],
    ["claude", "implementor"],
    ["statusline-setup", "implementor"],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ] as const)("maps %j to %s", (agentType, role) => {
    expect(nativeSubagentRole(agentType)).toBe(role);
  });
});

describe("effectiveThreadRole", () => {
  const thread = (
    relationshipToParent: "fork" | "subagent" | null,
    branch: string | null = null,
    worktreePath: string | null = null,
  ) => ({ branch, worktreePath, lineage: { relationshipToParent } });

  it("defaults user-started threads to Orchestrator and agents or worktree threads to Implementor", () => {
    expect(effectiveThreadRole(thread(null))).toBe("orchestrator");
    expect(effectiveThreadRole(thread("fork"))).toBe("orchestrator");
    // A Scratch thread's own folder has no branch and is not a worktree.
    expect(effectiveThreadRole(thread(null, null, "/scratch/notes"))).toBe("orchestrator");
    expect(effectiveThreadRole(thread(null, "t3/x", "/wt/x"))).toBe("implementor");
    expect(effectiveThreadRole(thread("subagent"))).toBe("implementor");
    expect(effectiveThreadRole({ ...thread("subagent"), role: "reviewer" })).toBe("reviewer");
  });
});
