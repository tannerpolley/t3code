import { resolveThreadRole } from "./threadRole.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

describe("delegation roles", () => {
  it("accepts all standard roles and maps legacy caller names without changing targets", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
    const target = {
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    for (const [input, expected] of [
      ["orchestrator", "orchestrator"],
      ["implementor", "implementor"],
      ["reviewer", "reviewer"],
      ["investigator", "investigator"],
      ["checker", "checker"],
      ["implementation", "implementor"],
      ["research", "investigator"],
      ["review", "reviewer"],
      ["design", "investigator"],
      ["test", "checker"],
      ["general", "implementor"],
      ["fast-builder", "implementor"],
      ["thorough-builder", "implementor"],
      ["bounded-worker", "implementor"],
      ["quick-claude", "implementor"],
      ["evidence-gatherer", "investigator"],
      ["strong-reviewer", "reviewer"],
      ["implementor-fast", "implementor"],
      ["implementor-thorough", "implementor"],
    ]) {
      const decoded = decode({ task: "Do the work", role: input, target });
      expect(resolveThreadRole(decoded.role!)).toBe(expected);
      expect(decoded.target).toEqual(target);
    }
  });
});
