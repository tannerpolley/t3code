import { assert, describe, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { DEFAULT_SERVER_SETTINGS, resolveModelRoles } from "@t3tools/contracts";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3ModelNotesInstructions,
  t3ModelRolesInstructions,
  t3OrchestrationPolicy,
  t3OrchestrationText,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "make new top-level threads");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never mean one");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "another provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3_request_user_input");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Multiple selections:");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "independent Reviewer only when the owner or plan asks.",
    );
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
