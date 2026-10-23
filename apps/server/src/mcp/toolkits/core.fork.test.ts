import * as OwnerDecisions from "../../issues/OwnerDecisions.ts";
import { ProjectArtifactsToolkit } from "./projectArtifacts/tools.ts";
import * as IssueLinks from "../../issues/IssueLinks.ts";
import * as IssueInbox from "../../issues/IssueInbox.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { expect, it } from "@effect/vitest";

import {
  EnvironmentId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { McpSchema, McpServer, Tool } from "effect/ai";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";

import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";

import { ProjectToolkit } from "./project/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";

import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(OwnerDecisions.OwnerDecisions)({})),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";

const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

const layerThreadToolkit = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(OrchestratorV2)({})),
);

const decodeRepositoryLimit = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.set_repository_worker_limit.parametersSchema,
);

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    ProjectArtifactsToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    DeviceToolkit,
    PullRequestsToolkit,
    HtmlToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      const definition = resolveT3McpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveT3McpToolPresentation(name)?.logo, name).toBe("t3-code");
        expect(resolveT3McpToolDefinition(name)?.summaryAction, name).not.toBeNull();
      }
    }
  }
  expect(names.has("set_repository_worker_limit")).toBe(true);
  const limitTool = OrchestratorToolkit.tools.set_repository_worker_limit;
  expect(
    decodeRepositoryLimit({
      host: "github.com",
      repository: "owner/repo",
      readOnlyLimit: 4,
      expectedRevision: 1,
      clientRequestId: "limit-read-only",
    }),
  ).toHaveProperty("readOnlyLimit", 4);
  expect(limitTool.description).toContain("readOnlyLimit");
  expect(names.has("t3_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
  for (const name of ["request_owner_decision", "list_owner_decisions", "withdraw_owner_decision"])
    expect(names.has(name)).toBe(true);
  expect(names.has("choose_owner_decision")).toBe(false);
});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("refuses act-as-caller tools to a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(IssueLinks.IssueLinks)({})),
        Layer.provide(Layer.mock(IssueInbox.IssueInbox)({})),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(IssueLinks.IssueLinks)({})),
        Layer.provide(Layer.mock(IssueInbox.IssueInbox)({})),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect.each(["t3_thread_interrupt", "t3_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "t3_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provide(Layer.mock(IssueLinks.IssueLinks)({})),
          Layer.provide(Layer.mock(IssueInbox.IssueInbox)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        ),
      ),
    ),
);

it.effect("discovers workflow stop targets and requires orchestration capability", () => {
  const threadId = ThreadId.make("workflow-parent");
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const subagentId = NodeId.make("workflow-coordinator");
  const itemId = TurnItemId.make("workflow-coordinator-activity");
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: shell.activeRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: "Workflow: checkout review",
      startedAt: shell.createdAt,
      completedAt: null,
      updatedAt: shell.updatedAt,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make("workflow-child"),
      prompt: "Review checkout",
      result: null,
    },
  };
  const stopped: Array<{ readonly threadId: ThreadId; readonly subagentId: string }> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = clientScope("full-access");
    const read = yield* server
      .callTool({ name: "t3_thread_read", arguments: { threadId, view: "activity" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(read.isError).toBe(false);
    const result = yield* decodeThreadReadResult(read.structuredContent);
    expect(result.items[0]?.subagentId).toBe(subagentId);
    const call = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name: "t3_workflow_stop",
          arguments: { threadId, subagentId: result.items[0]?.subagentId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const denied = yield* call({ ...scope, capabilities: new Set(["worktree"]) });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(stopped).toEqual([]);
    const allowed = yield* call(scope);
    expect(allowed.isError).toBe(false);
    expect(stopped).toEqual([{ threadId: "workflow-parent", subagentId: "workflow-coordinator" }]);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(IssueLinks.IssueLinks)({})),
        Layer.provide(Layer.mock(IssueInbox.IssueInbox)({})),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getTimelinePage: () => Effect.succeed({ items: [row], totalItems: 1, hasMore: false }),
            stopWorkflow: (input) =>
              Effect.sync(() => {
                stopped.push(input);
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  );
});
