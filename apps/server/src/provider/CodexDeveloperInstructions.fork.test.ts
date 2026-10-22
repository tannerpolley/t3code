import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  it("splits managed issue instructions into entries within Codex's context cap", () => {
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      false,
      [],
      true,
    );
    const first = context.t3_code_orchestration_01?.value ?? "";
    const orchestration = Object.entries(context)
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n\n");

    NodeAssert.match(first, /^Keep issues current through propose_issue_change/);
    NodeAssert.match(
      orchestration,
      /Native subagent tools are disabled in this repository-managed session/,
    );
    for (const [key, entry] of Object.entries(context)) {
      NodeAssert.ok(
        Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
        `${key} exceeds Codex's per-entry context cap`,
      );
    }
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("routes unresolved Default mode questions through the native question tool", () => {
    const instructions = buildCodexDeveloperInstructions("default");

    NodeAssert.match(instructions, /Use the `request_user_input` tool only when it is listed/);
    NodeAssert.match(
      instructions,
      /When a missing answer would materially change the task[\s\S]*ask with `request_user_input` and wait for the answer/,
    );
    NodeAssert.match(instructions, /If the tool is unavailable or fails, report the blocker/);
  });
});
