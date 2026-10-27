import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadToolkitHandlers from "./toolkits/thread/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as AttachmentToolkitHandlers from "./toolkits/attachment/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");

const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("taskStatus reports a child waiting on the orchestrator, but not an auth refresh", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [
      {
        id: "request-mcp-question",
        responseCapability: { type: "live" },
        kind: "user_input",
        status: "pending",
        routedTo: parentThreadId,
      },
      {
        id: "request-mcp-auth",
        responseCapability: { type: "live" },
        kind: "auth_refresh",
        status: "pending",
      },
    ],
    turnItems: [
      {
        type: "user_input_request",
        requestId: "request-mcp-question",
        questions: [{ id: "q1", header: "Scope", question: "Fix the lexer too?", options: [] }],
      },
    ],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(null),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.status).toBe("running");
    expect(result.waitingOnUser).toEqual({
      kind: "input",
      requestIds: ["request-mcp-question"],
      waitingOn: "orchestrator",
      preview: expect.stringContaining("Fix the lexer too?"),
    });
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("refuses delegated child messages, attachments, and queue sends to ancestors", async () => {
  const rootId = ThreadId.make("thread-mcp-lineage-root");
  const childId = ThreadId.make("thread-mcp-lineage-child");
  const grandchildId = ThreadId.make("thread-mcp-lineage-grandchild");
  const unrelatedId = ThreadId.make("thread-mcp-lineage-unrelated");
  const subagentOf = (parentId: ThreadId) => ({
    parentThreadId: parentId,
    relationshipToParent: "subagent" as const,
    rootThreadId: rootId,
  });
  const projections = new Map(
    (
      [
        [rootId, null],
        [childId, subagentOf(rootId)],
        [grandchildId, subagentOf(childId)],
        [unrelatedId, null],
      ] as const
    ).map(([threadId, lineage]) => {
      const thread = baseThread({
        threadId,
        title: threadId,
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      });
      return [
        threadId,
        {
          thread: { ...thread, activeRunId, ...(lineage === null ? {} : { lineage }) },
          runs: [makeRun({ id: RunId.make(`run-${threadId}`), ordinal: 1, status: "running" })],
          runtimeRequests: [],
          messages: [],
          contextTransfers: [],
          subagents: [],
        } as unknown as OrchestrationV2ThreadProjection,
      ] as const;
    }),
  );
  const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
    ...makeScope(),
    thread: { ...makeScope().thread!, threadId },
  });

  let dispatches = 0;
  const layer = layerOrchestratorService.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => {
            dispatches++;
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getThreadShell: (threadId) =>
            Effect.succeed(
              (projections.get(threadId)?.thread ?? null) as OrchestrationV2ThreadShell | null,
            ),
          getProjectThreadRecords: (input) => Effect.succeed(projections.get(input.threadId)!),
          sendToThread: (input) =>
            Effect.succeed({
              run: { id: `run-sent-${input.threadId}`, status: "queued" },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ThreadSearch.ThreadSearch)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-ancestor-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(ServerSecretStore.ServerSecretStore)({}),
        NodeServices.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scopeFor(childId)),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const send = (from: ThreadId, to: ThreadId) =>
      service.sendToThread(scopeFor(from), { threadId: to, message: "progress update" });

    const toParent = yield* send(childId, rootId).pipe(Effect.flip);
    expect(toParent.code).toBe("ancestor_send_denied");
    expect(toParent.message).toContain("final message");
    expect(toParent.message).toContain("t3_request_user_input");
    const toGrandparent = yield* send(grandchildId, rootId).pipe(Effect.flip);
    expect(toGrandparent.code).toBe("ancestor_send_denied");

    expect((yield* send(childId, unrelatedId)).threadId).toBe(unrelatedId);
    expect((yield* send(rootId, childId)).threadId).toBe(childId);

    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ThreadToolkitHandlers.layer)),
    );
    const queueTarget = { threadId: rootId, queuedRunId: RunId.make("run-parent-queued") };
    const edited = yield* toolkit
      .handle("t3_queue", { action: "edit", ...queueTarget, text: "child-injected text" })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(edited.at(-1)?.result).toMatchObject({ code: "ancestor_send_denied" });
    const promoted = yield* toolkit
      .handle("t3_queue", { action: "promote_to_steer", ...queueTarget, targetRunId: activeRunId })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(promoted.at(-1)?.result).toMatchObject({ code: "ancestor_send_denied" });
    expect(dispatches).toBe(0);

    const attachments = yield* AttachmentToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(AttachmentToolkitHandlers.layer)),
    );
    const attachmentSend = yield* attachments
      .handle("t3_thread_send_attachments", {
        threadId: rootId,
        message: "child-injected attachment",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "report.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(attachmentSend.at(-1)?.result).toMatchObject({ code: "ancestor_send_denied" });
    expect(dispatches).toBe(0);

    const unrelatedEdit = yield* toolkit
      .handle("t3_queue", {
        action: "edit",
        ...queueTarget,
        threadId: unrelatedId,
        text: "allowed message",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(unrelatedEdit.at(-1)?.result).toEqual({ sequence: 1 });
    expect(dispatches).toBe(1);

    // Corrupt lineage must terminate even when the target is outside the cycle.
    const root = projections.get(rootId)!;
    projections.set(rootId, { ...root, thread: { ...root.thread, lineage: subagentOf(childId) } });
    expect((yield* send(childId, unrelatedId)).threadId).toBe(unrelatedId);
    expect((yield* send(grandchildId, rootId).pipe(Effect.flip)).code).toBe("ancestor_send_denied");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
