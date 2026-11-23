import * as NodeAssert from "node:assert/strict";

import { t3OrchestrationPolicy } from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  it.each([
    ["worker", /Native subagent tools are disabled in this repository-managed session/],
    ["implementor", /role: "reviewer"/],
    ["root", /use native subagent tools only for your own work while no issue workers run/i],
  ] as const)("splits %s managed issue instructions within Codex's context cap", (role, native) => {
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      false,
      t3OrchestrationPolicy(role),
    );
    NodeAssert.equal(context.t3_code_model_roles, undefined);
    NodeAssert.equal(context.t3_code_model_notes, undefined);
    const first = context.t3_code_orchestration_01?.value ?? "";
    const orchestration = Object.entries(context)
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n\n");

    NodeAssert.match(first, /^Keep issues current through propose_issue_change/);
    NodeAssert.match(orchestration, native);
    NodeAssert.match(orchestration, /independent Reviewer only when the owner or plan asks/);
    if (role === "implementor") {
      NodeAssert.match(orchestration, /before a third fix round/);
      NodeAssert.match(orchestration, /after material changes/);
      NodeAssert.match(orchestration, /merge-ready/);
    }
    const statusInstruction = /Answer status questions with `repository_status`/;
    if (role === "root") NodeAssert.match(orchestration, statusInstruction);
    else NodeAssert.doesNotMatch(orchestration, statusInstruction);
    for (const [key, entry] of Object.entries(context)) {
      NodeAssert.ok(
        Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
        `${key} exceeds Codex's per-entry context cap`,
      );
    }
  });
});
