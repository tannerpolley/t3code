import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import {
  DEFAULT_MODEL_ROLES,
  MAX_MODEL_ROLE_DESCRIPTION_LENGTH,
  MAX_MODEL_ROLE_MODEL_LENGTH,
  MAX_MODEL_ROLE_NAME_LENGTH,
  MAX_MODEL_ROLE_OPTION_LENGTH,
  MAX_MODEL_ROLE_OPTIONS,
  MAX_MODEL_ROLES,
  MAX_MODEL_ROLE_TARGETS,
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
} from "./orchestrationInstructions.ts";

const decodeModelRoles = Schema.decodeUnknownSync(ModelRoles);

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3_request_user_input");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
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
      targets: Arr.map(role.targets, (target, index) => ({
        ...target,
        unavailableReason: role.id === "reviewer" ? unavailable : null,
        ...(role.id === "implementor-fast" && index === 0
          ? {
              weeklyUsage: {
                remainingPercent: 42,
                resetsAt: "2026-07-24T08:59:00.000Z",
                pace: "under" as const,
              },
            }
          : {}),
      })),
    }));
    const text = t3ModelRolesInstructions(roles);
    assert.include(
      text,
      "The user's choices for delegated work are equal alternatives, ordered by current weekly headroom, with more quota left relative to time remaining first. You may override this order for task fit; explicit user instructions win.",
    );
    assert.include(
      text,
      '- Checker (role: checker): Check a build for missed places, weak tests and edge cases. gpt-6.1-sol high (codex). Target JSON: `{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"high"}}`',
    );
    assert.include(
      text,
      '- Investigator (role: investigator): Gather evidence and investigate questions. gpt-6-luna max (codex). Target JSON: `{"providerInstanceId":"codex","model":"gpt-6-luna","options":{"reasoningEffort":"max"}}`',
    );
    assert.notInclude(text, "The first choice is the default");
    const fastBuilder = text
      .split("\n")
      .find((line) => line.startsWith("- Implementor · Fast (role: implementor):"))!;
    assert.include(
      fastBuilder,
      "claude-opus-5-5 medium (claudeAgent). Weekly usage: 42% left; resets 2026-07-24T08:59:00.000Z; pace under. Target JSON:",
    );
    assert.include(
      fastBuilder,
      'claude-opus-5-5 medium (claudeAgent). Weekly usage: 42% left; resets 2026-07-24T08:59:00.000Z; pace under. Target JSON: `{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":{"effort":"medium"}}` or gpt-6.1-sol medium (codex). Target JSON: `{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"medium"}}`',
    );
    // An unavailable choice keeps its label but offers no target JSON to delegate to.
    assert.include(
      text,
      `- Reviewer (role: reviewer): Strong read-only review and design guidance. gpt-6-astra xhigh (codex). Unavailable: ${unavailable}`,
    );
    assert.notInclude(text, '"model":"gpt-6-astra"');
    assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 6);
    assert.isAtMost(text.length, MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH);
    assert.equal(t3OrchestrationInstructions(roles), T3_CODE_ORCHESTRATION_INSTRUCTIONS + text);
    assert.equal(t3OrchestrationInstructions([]), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("keeps an available alternative when an earlier choice is unavailable", () => {
    const role = DEFAULT_MODEL_ROLES[1]!;
    const text = t3ModelRolesInstructions([
      {
        ...role,
        targets: Arr.map(role.targets, (target, index) => ({
          ...target,
          unavailableReason: index === 0 ? "Provider is disabled." : null,
        })),
      },
    ]);
    assert.include(
      text,
      "claude-opus-5-5 medium (claudeAgent). Unavailable: Provider is disabled. or",
    );
    assert.notInclude(text, '"providerInstanceId":"claudeAgent"');
    assert.include(
      text,
      '"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"medium"}',
    );
  });

  it("shortens an oversized role without cutting its exact target JSON", () => {
    const role = DEFAULT_MODEL_ROLES[1]!;
    const first = {
      ...role.targets[0],
      options: Array.from({ length: MAX_MODEL_ROLE_OPTIONS }, (_, index) => ({
        id: `option-${index}`,
        value: "x".repeat(MAX_MODEL_ROLE_OPTION_LENGTH),
      })),
      unavailableReason: null,
    };
    const rendered = t3ModelRolesInstructions([
      {
        ...role,
        targets: [
          first,
          ...Array.from({ length: 11 }, (_, index) => ({
            ...first,
            model: `alternative-${index}`,
          })),
        ],
      },
    ]);
    const targets = [...rendered.matchAll(/Target JSON: `([^`]+)`/g)];
    assert.isAbove(targets.length, 0);
    assert.isBelow(targets.length, 12);
    for (const match of targets) {
      assert.equal(Object.keys(JSON.parse(match[1]!).options).length, MAX_MODEL_ROLE_OPTIONS);
    }
    assert.include(rendered, `- ${role.name}`);
    assert.include(rendered, "More choices: call `orchestrator_capabilities`");
    assert.isAtMost(rendered.length, MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH);
  });

  it.each([
    ["plain", "x"],
    ["escaped", "\u0001"],
  ])("stays within its cap at the largest %s roles settings accept", (_, char) => {
    const text = (length: number) => char.repeat(length);
    const largest = decodeModelRoles(
      Array.from({ length: MAX_MODEL_ROLES - 6 }, (__, index) => ({
        id: `role-${index}`,
        name: text(MAX_MODEL_ROLE_NAME_LENGTH),
        description: text(MAX_MODEL_ROLE_DESCRIPTION_LENGTH),
        targets: Array.from({ length: MAX_MODEL_ROLE_TARGETS }, () => ({
          providerInstanceId: "codex",
          model: text(MAX_MODEL_ROLE_MODEL_LENGTH),
          options: Array.from({ length: MAX_MODEL_ROLE_OPTIONS }, (___, option) => ({
            id: `${option}${text(MAX_MODEL_ROLE_OPTION_LENGTH - 1)}`,
            value: text(MAX_MODEL_ROLE_OPTION_LENGTH),
          })),
        })),
      })),
    ).map((role) => ({
      ...role,
      targets: Arr.map(role.targets, (target) => ({ ...target, unavailableReason: null })),
    }));
    const rendered = t3ModelRolesInstructions(largest);
    assert.isAtMost(rendered.length, MAX_MODEL_ROLES_INSTRUCTIONS_LENGTH);
    assert.equal(
      rendered.split("\n").filter((line) => line.startsWith("- ")).length,
      largest.length,
    );
    for (const role of largest) assert.include(rendered, `- ${role.name}`);
    assert.include(rendered, "More choices: call `orchestrator_capabilities`");
    for (const match of rendered.matchAll(/Target JSON: `([^`]+)`/g))
      assert.doesNotThrow(() => JSON.parse(match[1]!));
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
