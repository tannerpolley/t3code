import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { t3OrchestrationPolicy } from "@t3tools/provider-core/server/orchestrationInstructions";

import {
  claudeEffectiveQueryPolicyKey,
  claudeMcpQueryOverrides,
  claudeRuntimeQueryPolicyForRuntimePolicy,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const session = {
  environmentId: EnvironmentId.make("managed-environment"),
  threadId: ThreadId.make("managed-claude"),
  providerSessionId: "managed-session",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer test-token",
  browserToolsAvailable: false,
};
const policy = claudeRuntimeQueryPolicyForRuntimePolicy({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const overrides = (orchestration?: ReturnType<typeof t3OrchestrationPolicy>) =>
  claudeMcpQueryOverrides({
    mcpSession: orchestration === undefined ? session : { ...session, orchestration },
    readOnlySandbox: false,
  });

describe("repository-managed Claude delegation", () => {
  it("removes Claude spawning tools in bypass mode and changes the live-query reuse key", () => {
    const ordinary = overrides();
    const managed = overrides(t3OrchestrationPolicy("worker"));
    const options = makeClaudeQueryOptions({
      modelSelection: { instanceId: session.providerInstanceId, model: "claude-sonnet-5-5" },
      nativeThreadId: "managed-native-claude",
      resume: true,
      cwd: "/workspace",
      permissionMode: "bypassPermissions",
      ...managed,
    });
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.deepEqual(options.disallowedTools, ["Agent", "Task", "TeamCreate"]);
    assert.include(options.allowedTools ?? [], "mcp__t3-code__*");
    assert.isUndefined(ordinary.disallowedTools);
    const implementor = overrides(t3OrchestrationPolicy("implementor"));
    assert.deepEqual(implementor.disallowedTools, ["Agent", "Task", "TeamCreate"]);
    assert.include(implementor.orchestration?.sections.join("\n") ?? "", 'role: "reviewer"');
    const append =
      typeof options.systemPrompt === "object" && "append" in options.systemPrompt
        ? options.systemPrompt.append
        : "";
    // The managed block is its own paragraph after the runtime block.
    assert.include(append, "</pull_request_linking>\n\nKeep issues current");
    assert.include(append, "Native subagent tools are disabled");
  });

  it("restarts a live query on a thread role change", () => {
    const keys = [
      overrides(t3OrchestrationPolicy()),
      overrides(t3OrchestrationPolicy("root")),
      overrides(t3OrchestrationPolicy("worker")),
      overrides(t3OrchestrationPolicy(undefined, "writer")),
    ].map((mcpOverrides) => claudeEffectiveQueryPolicyKey(policy, mcpOverrides));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("keeps native subagents for the repository root's own work", () => {
    const root = overrides(t3OrchestrationPolicy("root"));
    assert.isUndefined(root.disallowedTools);
    assert.isTrue(root.orchestration?.nativeSubagents);
  });
});
