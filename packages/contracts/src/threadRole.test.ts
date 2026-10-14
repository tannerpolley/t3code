import { describe, expect, it } from "@effect/vitest";

import { nativeSubagentRole } from "./threadRole.ts";

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
    ["task-manager", undefined],
    ["default-reviewer", "reviewer"],
    // Unmappable types stay role-less.
    ["Plan", undefined],
    ["claude", undefined],
    ["statusline-setup", undefined],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ] as const)("maps %j to %s", (agentType, role) => {
    expect(nativeSubagentRole(agentType)).toBe(role);
  });
});
