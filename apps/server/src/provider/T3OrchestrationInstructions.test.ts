import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLE_MODEL_LENGTH,
  MAX_MODEL_ROLE_NAME_LENGTH,
  MAX_MODEL_ROLE_OPTION_LENGTH,
  MAX_MODEL_ROLE_OPTIONS,
  MAX_MODEL_ROLES,
  ModelRoles,
} from "@t3tools/contracts";

import {
  MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH,
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
    const unavailable = "Provider codex cannot run a child task: Provider is not authenticated.";
    const roles = DEFAULT_MODEL_ROLES.map((role) => ({
      ...role,
      unavailableReason: role.id === "strong-reviewer" ? unavailable : null,
    }));
    const text = t3ModelRolesInstructions(roles);
    assert.include(text, "Use them at your discretion; explicit user instructions win.");
    assert.include(
      text,
      '- Checker: Read-only review of a build: missed places, weak tests, edge cases; budget review and sanity checks. Target: `{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"high"}}`',
    );
    assert.include(
      text,
      '- Quick Claude: Quick, well-specified Claude-side work. Target: `{"providerInstanceId":"claudeAgent","model":"claude-sonnet-5-5","options":{"effort":"medium"}}`',
    );
    // An unavailable role keeps its line but offers no target to delegate to.
    assert.include(
      text,
      `- Strong reviewer: Strong review, or guidance for the orchestrator on a plan, a stuck diagnosis or a design call. Unavailable: ${unavailable}`,
    );
    assert.notInclude(text, "gpt-6-astra");
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 7);
    assert.isBelow(text.length, 1_700);
    assert.equal(t3OrchestrationInstructions(roles), T3_CODE_ORCHESTRATION_INSTRUCTIONS + text);
    assert.equal(t3OrchestrationInstructions([]), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it.each([
    ["plain", "x"],
    ["escaped", "\u0001"],
  ])("stays within its cap at the largest %s roles settings accept", (_, char) => {
    const text = (length: number) => char.repeat(length);
    const largest = decodeModelRoles(
      Array.from({ length: MAX_MODEL_ROLES }, (__, index) => ({
        id: `role-${index}`,
        name: text(MAX_MODEL_ROLE_NAME_LENGTH),
        description: text(MAX_MODEL_ROLE_DESCRIPTION_LENGTH),
        target: {
          providerInstanceId: "codex",
          model: text(MAX_MODEL_ROLE_MODEL_LENGTH),
          options: Array.from({ length: MAX_MODEL_ROLE_OPTIONS }, (___, option) => ({
            id: `${option}${text(MAX_MODEL_ROLE_OPTION_LENGTH - 1)}`,
            value: text(MAX_MODEL_ROLE_OPTION_LENGTH),
          })),
        },
      })),
    ).map((role) => ({ ...role, unavailableReason: null }));
    const rendered = t3ModelRolesInstructions(largest);
    assert.isAtMost(rendered.length, MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH);
    assert.match(rendered, /- \d+ more roles not shown; call `orchestrator_capabilities`/);
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
