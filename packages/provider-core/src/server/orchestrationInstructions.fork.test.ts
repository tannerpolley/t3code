import { assert, describe, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { DEFAULT_SERVER_SETTINGS, resolveModelRoles } from "@t3tools/contracts";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3ModelNotesInstructions,
  t3ModelRolesInstructions,
  t3OrchestrationBaseInstructions,
  t3OrchestrationPolicy,
  t3OrchestrationText,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "`t3_thread_launch` opens a top-level thread",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never mean one");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "another provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3_request_user_input");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Multiple selections:");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "independent Reviewer only when the owner or plan asks.",
    );
  });

  it.each([
    [undefined, "- Subagents:"],
    ["worker", "Native subagent tools are disabled in this repository-managed session"],
    ["implementor", 'role: "reviewer"'],
    ["root", "Leave the review loop with the Implementor"],
  ] as const)("renders complete orchestration instructions for %s", (role, delegation) => {
    const policy = t3OrchestrationPolicy(role, "");
    const text = t3OrchestrationText(policy);

    assert.include(text, "## T3 Code orchestration");
    assert.include(text, delegation);
    assert.include(text, "Call `orchestrator_capabilities` once per thread");
    assert.include(text, "independent Reviewer only when the owner or plan asks");
    assert.include(text, "Multiple selections: use `t3_request_user_input`");
    assert.include(text, "### Visuals and preview");
    if (role === undefined) {
      assert.notInclude(text, "propose_issue_change");
    } else {
      assert.include(text, "Submit the typed proposal and follow its returned decision.");
      assert.include(text, "Reuse its `clientRequestId` on retry.");
      assert.notInclude(text, "always wait");
      assert.include(
        text,
        "Do not poll task_status or create recurring user schedules to advance a milestone.",
      );
      assert.notInclude(text, "milestone..");
    }
    assert.isTrue(policy.sections.every((section) => Buffer.byteLength(section, "utf8") <= 4_000));
    assert.equal(t3OrchestrationBaseInstructions(role), text);
  });

  it("lists role defaults and choices, credit approval, and model notes", () => {
    const roles = resolveModelRoles(DEFAULT_SERVER_SETTINGS).map((role) => ({
      ...role,
      targets: Arr.map(role.targets, (target) => ({
        ...target,
        unavailableReason: role.id === "reviewer-complex" ? "Provider is not authenticated." : null,
      })),
    }));
    const credits = [
      {
        providerInstanceId: roles[4]!.targets[0].providerInstanceId,
        approved: true,
        resetCreditCount: 2,
      },
    ];
    const text = t3ModelRolesInstructions(roles, credits);
    assert.include(text, "Pass `role` and omit `target` to use the first choice at that level.");
    assert.include(text, "codex credits approved. Banked resets: 2.");
    assert.include(
      text,
      "claude-sonnet-5-5 medium (claudeAgent). or gpt-6.1-terra medium (codex).",
    );
    assert.include(
      text,
      "gpt-6.2-astra xhigh (codex). Unavailable: Provider is not authenticated.",
    );
    assert.notInclude(text, "Target JSON");
    assert.equal(t3ModelNotesInstructions([]), "");
    const notes = t3ModelNotesInstructions([
      { ...roles[2]!.targets[0], note: "Writing and research" },
    ]);
    assert.include(notes, "- claude-fable-5-2: Writing and research");
    assert.equal(
      t3OrchestrationText(t3OrchestrationPolicy(undefined, text, notes)),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS + text + notes,
    );
  });
});
