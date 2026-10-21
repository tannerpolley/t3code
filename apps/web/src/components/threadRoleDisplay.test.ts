import { nativeSubagentRole, THREAD_ROLES } from "@t3tools/contracts";
import { BriefcaseIcon, HardHatIcon, NetworkIcon, WrenchIcon } from "lucide-react";
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

  it("displays a delegated orchestrator as a Manager and a top-level one as the Orchestrator", () => {
    const delegated = threadRoleDisplay({ ...native, creationSource: "mcp", role: "orchestrator" });
    expect(delegated.label).toBe("Manager");
    expect(delegated.icon).toBe(BriefcaseIcon);
    expect(delegated.description).toContain("family of work for its parent orchestrator");
    const lead = threadRoleDisplay({
      ...native,
      creationSource: "web",
      role: "orchestrator",
      lineage: { relationshipToParent: null },
    });
    expect(lead.label).toBe("Orchestrator");
    expect(lead.icon).toBe(NetworkIcon);
    // A provider's own subagent keeps its native role name.
    expect(threadRoleDisplay({ ...native, role: "orchestrator" }).label).toBe("Orchestrator");
  });
});
