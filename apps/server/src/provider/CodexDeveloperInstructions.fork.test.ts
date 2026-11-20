import * as NodeAssert from "node:assert/strict";

import {
  THREAD_ROLES,
  MODEL_ROLE_LEVELS,
  resolveModelNotes,
  resolveModelRoles,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import {
  t3ModelNotesInstructions,
  t3ModelRolesInstructions,
  t3OrchestrationPolicy,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

const worstCase = Schema.decodeSync(ServerSettings)({
  modelRoles: Object.fromEntries(
    THREAD_ROLES.map((role) => [
      role,
      Object.fromEntries(
        MODEL_ROLE_LEVELS.map((level) => [
          level,
          { provider: "both", description: "界".repeat(200) },
        ]),
      ),
    ]),
  ),
  modelTiers: Object.fromEntries(
    [1, 2, 3, 4].map((tier) => [
      tier,
      {
        claude: { model: "甲".repeat(100), note: "界".repeat(200) },
        codex: { model: "乙".repeat(100), note: "界".repeat(200) },
      },
    ]),
  ),
});
const roles = resolveModelRoles(worstCase).map((role) => ({
  ...role,
  targets: Arr.map(role.targets, (target) => ({
    ...target,
    unavailableReason: "界".repeat(200),
    weeklyUsage: {
      remainingPercent: 0,
      resetsAt: "2026-12-01T12:00:00.000Z",
      pace: "ahead" as const,
    },
  })),
}));
const roleText = t3ModelRolesInstructions(roles, [
  {
    providerInstanceId: roles[0]!.targets[0].providerInstanceId,
    approved: true,
    extraUsageRemainingPercent: 100,
  },
  {
    providerInstanceId: roles[0]!.targets[1]!.providerInstanceId,
    approved: true,
    resetCreditCount: 12,
    balance: "界".repeat(100),
  },
]);
const modelNotes = t3ModelNotesInstructions(resolveModelNotes(worstCase.modelTiers));

describe("buildCodexAdditionalContext", () => {
  it.each([
    ["worker", /Native subagent tools are disabled in this repository-managed session/],
    ["implementor", /native read-only `reviewer`/],
    ["root", /use native subagent tools only for your own work while no issue workers run/i],
  ] as const)("splits %s managed issue instructions within Codex's context cap", (role, native) => {
    const context = buildCodexAdditionalContext(
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
      false,
      t3OrchestrationPolicy(role, roleText, modelNotes),
    );
    NodeAssert.equal(
      context.t3_code_model_roles?.value.split("\n").filter((line) => line.startsWith("- ")).length,
      5,
    );
    for (const role of THREAD_ROLES) {
      const line = roleText.split("\n").find((line) => line.includes(`(${role}):`));
      NodeAssert.match(line ?? "", /complex: 甲+… \(claudeAgent\).*routine: 甲+… \(claudeAgent\)/);
    }
    NodeAssert.equal(
      context.t3_code_model_notes?.value.split("\n").filter((line) => line.startsWith("- ")).length,
      8,
    );
    const first = context.t3_code_orchestration_01?.value ?? "";
    const orchestration = Object.entries(context)
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n\n");

    NodeAssert.match(first, /^Keep issues current through propose_issue_change/);
    NodeAssert.match(orchestration, native);
    NodeAssert.match(orchestration, /separate Reviewer thread only when the owner or plan asks/);
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
