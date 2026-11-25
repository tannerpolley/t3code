import { assert, describe, it } from "@effect/vitest";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3OrchestrationBaseInstructions,
  t3OrchestrationPolicy,
  t3OrchestrationText,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Launch top-level threads only on explicit request",
    );
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
    const policy = t3OrchestrationPolicy(role);
    const text = t3OrchestrationText(policy);

    assert.include(text, "## T3 Code orchestration");
    assert.include(text, delegation);
    assert.include(text, "read `orchestrator_capabilities`");
    assert.match(
      text,
      /Goal:.*Done when:.*Be exhaustive about:.*Out of scope:.*Owner decisions: quote the owner's exact words.*Return:/s,
    );
    assert.include(text, "independent Reviewer only when the owner or plan asks");
    assert.include(text, "Multiple selections: use `t3_request_user_input`");
    assert.include(text, "### Visuals and preview");
    if (role === undefined) {
      assert.notInclude(text, "propose_issue_change");
    } else {
      assert.include(text, "Submit the typed proposal and follow its returned decision.");
      assert.include(text, "Reuse its `clientRequestId` on retry.");
      assert.notInclude(text, "always wait");
      assert.notInclude(text, "agent-heavy");
      assert.include(text, "Do not poll it");
      assert.notInclude(text, "milestone..");
    }
    assert.isTrue(policy.sections.every((section) => Buffer.byteLength(section, "utf8") <= 4_000));
    assert.equal(t3OrchestrationBaseInstructions(role), text);
  });

  it.each([
    ["designer", "Research or plan the issue"],
    ["reviewer", "return findings to your parent"],
    ["writer", "Ask the owner directly"],
  ] as const)("loads only the current %s role's guidance", (role, guidance) => {
    const text = t3OrchestrationText(t3OrchestrationPolicy(undefined, role));
    assert.include(text, guidance);
    assert.include(
      text,
      "If you are a subagent or child, do the work yourself. Start subagents only when your task or role calls for it.",
    );
    assert.notInclude(text, "Use your native tool");
    assert.notInclude(text, "Weekly usage");
    assert.notInclude(text, "propose_issue_change");
  });

  it.each(["root", "worker", "implementor"] as const)(
    "requires %s to get approval before expanding issue scope",
    (role) => {
      const text = t3OrchestrationText(t3OrchestrationPolicy(role));
      assert.match(text, /Ask before expanding (the approved )?milestone or repository scope/);
    },
  );

  it.each([
    [undefined, undefined],
    ["root", "orchestrator"],
    ["worker", "orchestrator"],
    ["implementor", "implementor"],
    [undefined, "designer"],
    [undefined, "reviewer"],
    [undefined, "writer"],
  ] as const)("forbids fallback delegation for %s/%s", (managed, role) => {
    const text = t3OrchestrationText(t3OrchestrationPolicy(managed, role));
    assert.include(text, "Never fall back to native tools, Workflow or CLIs");
  });
});
