import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  claudeEffectiveQueryPolicyKey,
  claudeMcpQueryOverrides,
  claudeRuntimeQueryPolicyForRuntimePolicy,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

describe("repository-managed Claude delegation", () => {
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
    const ordinary = claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false });
    const managed = claudeMcpQueryOverrides({
      mcpSession: { ...session, managedIssue: "worker" },
      readOnlySandbox: false,
    });
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
  });

  it("keeps native subagents for the repository root's own work", () => {
    const root = claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: EnvironmentId.make("managed-environment"),
        threadId: ThreadId.make("repository-root"),
        providerSessionId: "root-session",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
        managedIssue: "root",
      },
      readOnlySandbox: false,
    });
    assert.isUndefined(root.disallowedTools);
    assert.equal(root.managedIssue, "root");
  });
});
