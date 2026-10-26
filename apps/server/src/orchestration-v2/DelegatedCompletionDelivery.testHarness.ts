import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import { runtimeRequestIsOwnerVisible } from "@t3tools/shared/delegatedRequestVisibility";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");

const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: Effect.fn("ProviderInstanceRegistry.ProviderInstanceRegistry.getInstance")(
      (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    ),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTestBase = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: Effect.fn("ProjectEnrichmentService.ProjectEnrichmentService.peek")(() =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      ),
      request: Effect.fn("ProjectEnrichmentService.ProjectEnrichmentService.request")(
        () => Effect.void,
      ),
      getAvailable: Effect.fn("ProjectEnrichmentService.ProjectEnrichmentService.getAvailable")(
        () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
      ),
      invalidate: Effect.fn("ProjectEnrichmentService.ProjectEnrichmentService.invalidate")(
        () => Effect.void,
      ),
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
);

const layerTest = DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(layerTestBase));

const seedParentWithTerminalTask = Effect.fn("seedParentWithTerminalTask")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const providerThreadId = ProviderThreadId.make(
    `provider-thread:${String(input.threadId).replace("thread:", "")}`,
  );

  yield* projects.create({
    commandId: CommandId.make(`command:seed-project:${input.threadId}`),
    projectId: input.projectId,
    title: "Delegated completion delivery",
    workspaceRoot: `/workspace/${input.projectId}`,
  });

  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:seed-create:${input.threadId}`),
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Delegated completion delivery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });

  yield* eventSink.write({
    commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
    events: [
      {
        id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
        type: "provider-thread.updated",
        threadId: input.threadId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: input.now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: input.threadId,
          ownerNodeId: input.rootNodeId,
          nativeThreadRef: {
            driver,
            nativeId: `native:${input.threadId}`,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
      },
      {
        id: EventId.make(`event:seed-run:${input.threadId}`),
        type: "run.updated",
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: input.now,
        payload: {
          id: input.runId,
          threadId: input.threadId,
          ordinal: 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
          rootNodeId: input.rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: input.now,
          startedAt: input.now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery:
              input.deliveryTaskIds === undefined
                ? null
                : {
                    generation: 1,
                    messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                    taskIds: input.deliveryTaskIds,
                  },
          },
        },
      },
      {
        id: EventId.make(`event:seed-task:${input.threadId}`),
        type: "subagent.updated",
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.taskId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: input.now,
        payload: {
          id: input.taskId,
          threadId: input.threadId,
          runId: input.runId,
          parentNodeId: input.rootNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Inspect the delivered ownership edge.",
          title: null,
          model: null,
          completionWake: input.completionWake ?? "settled_only",
          completionDelivery: {
            state: input.deliveryState,
            observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
          },
          status: "completed",
          result: "child finished",
          startedAt: input.now,
          completedAt: input.now,
          updatedAt: input.now,
        },
      },
    ],
  });
});

// Runtime reconciliation writes restart cancellations under this command
// prefix, which the live terminal-run listener skips.
const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const seedChildWaitingOnUser = Effect.fn("seedChildWaitingOnUser")(function* (input: {
  readonly name: string;
  readonly requestKind: "user_input" | "auth_refresh" | "command";
  readonly parentState?: "archived" | "deleted" | "missing";
  readonly origin?: "app_owned" | "provider_native";
  readonly legacyUnrouted?: boolean;
  /** settled_only with the parent run active is a blocking delegate_task wait. */
  readonly completionWake?: "always" | "settled_only";
  /** A Codex async question, answered by message, survives a restart. */
  readonly answeredByMessage?: boolean;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const parentThreadId = ThreadId.make(`thread:child-question-${input.name}-parent`);
  const childThreadId = ThreadId.make(`thread:child-question-${input.name}-child`);
  const runId = RunId.make(`run:child-question-${input.name}`);
  const taskId = NodeId.make(`node:child-question-${input.name}-task`);
  const requestNodeId = NodeId.make(`node:child-question-${input.name}-request`);
  const requestId = RuntimeRequestId.make(`request:child-question-${input.name}`);
  yield* seedParentWithTerminalTask({
    threadId: parentThreadId,
    projectId: ProjectId.make(`project:child-question-${input.name}`),
    runId,
    rootNodeId: NodeId.make(`node:child-question-${input.name}-root`),
    taskId,
    deliveryState: "claimed",
    now,
  });
  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
  const { completionDelivery: _completionDelivery, ...task } = parent.subagents[0]!;
  const parentRun = parent.runs[0]!;
  const attemptId = RunAttemptId.make(`attempt:child-question-${input.name}`);
  yield* sink.write({
    commandId: reconcileCommandId(`parent-node:${input.name}`),
    events: [
      {
        id: EventId.make(`event:child-question-${input.name}-parent-attempt`),
        type: "run-attempt.updated",
        threadId: parentThreadId,
        runId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: parentRun.rootNodeId!,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: parentRun.providerThreadId!,
          providerTurnId: null,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make(`event:child-question-${input.name}-active-attempt`),
        type: "run.updated",
        threadId: parentThreadId,
        runId,
        occurredAt: now,
        payload: { ...parentRun, activeAttemptId: attemptId },
      },
      {
        id: EventId.make(`event:child-question-${input.name}-parent-node`),
        type: "node.updated",
        threadId: parentThreadId,
        runId,
        occurredAt: now,
        payload: {
          id: parentRun.rootNodeId!,
          threadId: parentThreadId,
          runId,
          parentNodeId: null,
          rootNodeId: parentRun.rootNodeId!,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: parentRun.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
    ],
  });
  const seedEvents: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`event:child-question-${input.name}-task`),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId,
      nodeId: taskId,
      occurredAt: now,
      payload: {
        ...task,
        origin: input.origin ?? "app_owned",
        childThreadId,
        completionWake: input.completionWake ?? "always",
        status: "running",
        result: null,
        completedAt: null,
      },
    },
    {
      id: EventId.make(`event:child-question-${input.name}-thread`),
      type: "thread.created",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        ...parent.thread,
        id: childThreadId,
        title: "Review the parser",
        lineage: {
          parentThreadId:
            input.parentState === "missing"
              ? ThreadId.make("missing-orchestrator")
              : parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: parentThreadId,
        },
        forkedFrom: { type: "node", nodeId: taskId },
      },
    },
    {
      id: EventId.make(`event:child-question-${input.name}-request`),
      type: "runtime-request.updated",
      threadId: childThreadId,
      nodeId: requestNodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: requestNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: input.requestKind,
        status: "pending",
        responseCapability: input.answeredByMessage
          ? { type: "message" }
          : {
              type: "app_owned",
              providerSessionId: ProviderSessionId.make("provider-session:question-test"),
            },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      id: EventId.make(`event:child-question-${input.name}-item`),
      type: "turn-item.updated",
      threadId: childThreadId,
      nodeId: requestNodeId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:child-question-${input.name}`),
        threadId: childThreadId,
        runId: null,
        nodeId: requestNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...(input.requestKind === "command"
          ? {
              type: "approval_request" as const,
              requestId,
              requestKind: "command" as const,
              prompt: "cat /tmp/requested-file",
            }
          : {
              type: "user_input_request" as const,
              requestId,
              questions: [
                {
                  id: "q1",
                  header: "Scope",
                  question: "Should I also fix the lexer?",
                  options: [
                    { label: "Yes", description: "Fix both parser and lexer" },
                    { label: "No", description: "Keep the lexer unchanged" },
                  ],
                },
              ],
            }),
      },
    },
  ];
  if (input.legacyUnrouted) {
    yield* sink.write({
      commandId: reconcileCommandId(`legacy-child:${input.name}`),
      events: seedEvents.slice(0, 2),
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // Old fallback events were plain request updates without routedTo.
    for (const event of seedEvents.slice(2)) yield* projections.apply(event);
    yield* sink.write({
      commandId: reconcileCommandId(`legacy-question:${input.name}`),
      events: seedEvents.slice(2),
    });
    return { parentThreadId, childThreadId, requestId, projectId: parent.thread.projectId };
  }
  yield* sink.write({
    commandId: CommandId.make(`command:runtime-reconcile:seed-child:${input.name}`),
    events: seedEvents.slice(0, 2),
  });
  if (input.parentState !== undefined && input.parentState !== "missing")
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:parent-state:${input.name}`),
          type: "thread.metadata-updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...parent.thread,
            ...(input.parentState === "archived" ? { archivedAt: now } : { deletedAt: now }),
          },
        },
      ],
    });
  yield* sink.write({
    commandId: CommandId.make(`command:runtime-reconcile:seed-child-question:${input.name}`),
    events: seedEvents.slice(2),
  });
  return { parentThreadId, childThreadId, requestId, projectId: parent.thread.projectId };
});

const childQuestionNotices = Effect.fn("childQuestionNotices")(function* (
  parentThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
  return parent.messages.filter(
    (message) =>
      String(message.id).startsWith("message:delegated-task-question:") && message.runId !== null,
  );
});

const childQuestionWake = Effect.fn("childQuestionWake")(function* (parentThreadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const [notice] = yield* childQuestionNotices(parentThreadId);
  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
  return parent.runs.find((run) => run.id === notice?.runId);
});

/** Drive the reactor through the persisted request, then await its committed notice. */
const wakeChildQuestion = Effect.fn("wakeChildQuestion")(function* (child: {
  childThreadId: ThreadId;
  parentThreadId: ThreadId;
  requestId: RuntimeRequestId;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
  const projection = yield* orchestrator.getThreadProjection(child.childThreadId);
  const event = {
    id: EventId.make(`event:live-question:${child.requestId}`),
    type: "runtime-request.updated",
    threadId: child.childThreadId,
    occurredAt: yield* DateTime.now,
    payload: projection.runtimeRequests.find((request) => request.id === child.requestId)!,
  } satisfies OrchestrationV2DomainEvent;
  yield* sink.write({ events: [event] });
  yield* reactor.handle(event);
});

const ownerCanSee = Effect.fn("ownerCanSee")(function* (child: {
  childThreadId: ThreadId;
  parentThreadId: ThreadId;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const shell = yield* orchestrator.getThreadShell(child.childThreadId);
  const parent = yield* orchestrator.getThreadShell(child.parentThreadId);
  return runtimeRequestIsOwnerVisible(shell?.pendingRuntimeRequest, parent);
});

const endParentRuns = Effect.fn("endParentRuns")(function* (
  parentThreadId: ThreadId,
  status: "completed" | "interrupted" | "failed",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
  const now = yield* DateTime.now;
  yield* sink.write({
    commandId: reconcileCommandId(`visibility:${parentThreadId}:${status}`),
    events: parent.runs.map((run) => ({
      id: EventId.make(`event:visibility:${run.id}:${status}`),
      type: "run.updated" as const,
      threadId: parentThreadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status, queuePosition: null, completedAt: now },
    })),
  });
});
export {
  childQuestionNotices,
  childQuestionWake,
  driver,
  endParentRuns,
  layerTest,
  modelSelection,
  ownerCanSee,
  reconcileCommandId,
  seedChildWaitingOnUser,
  seedParentWithTerminalTask,
  wakeChildQuestion,
};
