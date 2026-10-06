import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  claudeEffectiveQueryPolicyKey,
  claudeMcpQueryOverrides,
  claudeRuntimeQueryPolicyForRuntimePolicy,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

describe("repository-managed native delegation", () => {
  it("overrides native spawning only for managed Codex sessions", () => {
    const threadId = ThreadId.make("managed-codex");
    const session = {
      environmentId: EnvironmentId.make("managed-environment"),
      threadId,
      providerSessionId: "managed-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer test-token",
      browserToolsAvailable: false,
    };
    try {
      McpProviderSession.setMcpProviderSession(session);
      assert.isUndefined(codexThreadRuntimeParams({ threadId }).config["features.multi_agent"]);
      McpProviderSession.setMcpProviderSession({ ...session, managedIssue: true });
      assert.isFalse(codexThreadRuntimeParams({ threadId }).config["features.multi_agent"]);
      assert.isFalse(codexThreadRuntimeParams({ threadId }).config["features.multi_agent_v2"]);
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("removes Claude spawning tools in bypass mode and changes the live-query reuse key", () => {
    const threadId = ThreadId.make("managed-claude");
    const session = {
      environmentId: EnvironmentId.make("managed-environment"),
      threadId,
      providerSessionId: "managed-session",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer test-token",
      browserToolsAvailable: false,
    };
    try {
      McpProviderSession.setMcpProviderSession(session);
      const ordinary = claudeMcpQueryOverrides({ threadId, readOnlySandbox: false });
      McpProviderSession.setMcpProviderSession({ ...session, managedIssue: true });
      const managed = claudeMcpQueryOverrides({ threadId, readOnlySandbox: false });
      const policy = claudeRuntimeQueryPolicyForRuntimePolicy({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      });
      assert.notEqual(
        claudeEffectiveQueryPolicyKey(policy, ordinary),
        claudeEffectiveQueryPolicyKey(policy, managed),
      );
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
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });
});
