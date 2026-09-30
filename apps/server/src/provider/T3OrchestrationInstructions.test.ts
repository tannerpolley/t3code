import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLES,
  ModelRoles,
} from "@t3tools/contracts";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3ModelRolesInstructions,
  t3OrchestrationInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

const decodeModelRoles = Schema.decodeUnknownSync(ModelRoles);

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3_request_user_input");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "native ask-user tool");
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("lists each model role on one line with its exact delegate_task target", () => {
    const text = t3ModelRolesInstructions(DEFAULT_MODEL_ROLES);
    assert.include(text, "Use them at your discretion; explicit user instructions win.");
    assert.include(
      text,
      '- Checker: Read-only review of a build: missed places, weak tests, edge cases; budget review and sanity checks. Target: `{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"high"}}`',
    );
    assert.include(
      text,
      '- Quick Claude: Quick, well-specified Claude-side work. Target: `{"providerInstanceId":"claudeAgent","model":"claude-sonnet-5-5","options":{"effort":"medium"}}`',
    );
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 7);
    assert.isBelow(text.length, 1_700);
    assert.equal(
      t3OrchestrationInstructions(DEFAULT_MODEL_ROLES),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS + text,
    );
    assert.equal(t3OrchestrationInstructions([]), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("stays bounded at the largest role list settings accept", () => {
    const role = DEFAULT_MODEL_ROLES[0]!;
    const largest = decodeModelRoles(
      Array.from({ length: MAX_MODEL_ROLES }, (_, index) => ({
        ...role,
        id: `role-${index}`,
        name: "n".repeat(60),
        description: "d".repeat(MAX_MODEL_ROLE_DESCRIPTION_LENGTH),
      })),
    );
    assert.isBelow(t3ModelRolesInstructions(largest).length, 8_000);
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });
});
