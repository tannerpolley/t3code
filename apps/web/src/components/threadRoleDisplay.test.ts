import { nativeSubagentRole, THREAD_ROLES } from "@t3tools/contracts";
import { HardHatIcon, WrenchIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { threadRoleDisplay, type RoleDisplayThread } from "./threadRoleDisplay";

const native: RoleDisplayThread = {
  role: undefined,
  creationSource: "provider",
  branch: null,
  worktreePath: null,
  lineage: { relationshipToParent: "subagent" },
};

describe("threadRoleDisplay", () => {
  it("displays only native Implementors as Workers, including generic and role-less agents", () => {
    for (const agentType of [undefined, "default", "general-purpose", "unknown-type"]) {
      const display = threadRoleDisplay({ ...native, role: nativeSubagentRole(agentType) });
      expect(display.label).toBe("Worker");
      expect(display.icon).toBe(HardHatIcon);
      expect(display.description).toContain("Carries out work assigned by its parent");
      expect(display.description).toContain("Provider's own subagent");
      expect(display.description).toContain("Runs on its own · Open parent to direct it");
    }
    for (const role of THREAD_ROLES.filter((role) => role !== "implementor")) {
      const display = threadRoleDisplay({ ...native, role });
      expect(display.label.toLowerCase()).toBe(role);
      expect(display.description).toContain("Provider's own subagent");
    }
    for (const agentType of ["reviewer", "explorer", "manager", "tester"]) {
      expect(threadRoleDisplay({ ...native, role: nativeSubagentRole(agentType) }).label).not.toBe(
        "Worker",
      );
    }
    const child = threadRoleDisplay({ ...native, creationSource: "mcp" });
    expect(child.label).toBe("Implementor");
    expect(child.icon).toBe(WrenchIcon);
    expect(child.description).toContain("Child thread · You can send messages here");
    expect(child.description).not.toContain("Provider's own subagent");
    expect(
      threadRoleDisplay({
        ...native,
        role: "implementor",
        lineage: { relationshipToParent: null },
      }).label,
    ).toBe("Implementor");
  });
});
