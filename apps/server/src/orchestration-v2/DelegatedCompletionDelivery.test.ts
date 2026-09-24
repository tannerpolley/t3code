import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
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
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  ChildQuestionWake,
  layer as ChildQuestionWakeLayer,
  makeNotifyParent,
} from "./ChildQuestionWake.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layer as ProjectionStoreLayer, ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const TestLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectionStoreLayer,
).pipe(
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const applicationEngine = yield* OrchestrationEngineService;
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* applicationEngine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: DateTime.formatIso(input.now),
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
              settledDeliveryCount: 1,
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

it.layer(TestLayer)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      assert.equal(
        cohort?.settledDeliveryCount,
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.settledDeliveryCount,
      );
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-live-cohort");
      const projectId = ProjectId.make("project:delegated-delivery-live-cohort");
      const runId = RunId.make("run:delegated-delivery-live-cohort");
      const rootNodeId = NodeId.make("node:delegated-delivery-live-cohort-root");
      const firstTaskId = NodeId.make("node:delegated-delivery-live-cohort-first");
      const secondTaskId = NodeId.make("node:delegated-delivery-live-cohort-second");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegated-delivery-live-cohort"),
        threadId,
        messageId,
        text: `Delegated task ${firstTaskId} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId],
        },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.include(message?.text ?? "", String(firstTaskId));
      assert.include(message?.text ?? "", String(secondTaskId));
      assert.include(message?.text ?? "", "task_status");
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        settledDeliveryCount: 1,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        // Distinct command IDs mirror task_status vs t3_thread_read racing after
        // their shared read preflight saw delivered ownership.
        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        // Idempotent replay keeps the first observation's ownership and timestamp.
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );
});

const seedChildWaitingOnUser = (input: {
  readonly name: string;
  readonly requestKind: "user_input" | "auth_refresh";
  /** settled_only with the parent run active is a blocking delegate_task wait. */
  readonly completionWake?: "always" | "settled_only";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
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
    yield* sink.write({
      commandId: CommandId.make(`command:seed-child-question:${input.name}`),
      events: [
        {
          id: EventId.make(`event:child-question-${input.name}-task`),
          type: "subagent.updated",
          threadId: parentThreadId,
          runId,
          nodeId: taskId,
          occurredAt: now,
          payload: {
            ...task,
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
              parentThreadId,
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
            responseCapability: { type: "message" },
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
            type: "user_input_request",
            requestId,
            questions: [
              {
                id: "q1",
                header: "Scope",
                question: "Should I also fix the lexer?",
                options: [],
              },
            ],
          },
        },
      ],
    });
    return { parentThreadId, childThreadId, requestId };
  });

const childQuestionNotices = (parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    return parent.messages.filter((message) =>
      String(message.id).startsWith("message:child-question:"),
    );
  });

it.layer(TestLayer)("child question wake", (it) => {
  it.effect("tells the parent once per request, even when notified again after a restart", () =>
    Effect.gen(function* () {
      const seeded = yield* seedChildWaitingOnUser({ name: "on", requestKind: "user_input" });
      const settings = ServerSettingsService.layerTest();
      const notify = yield* makeNotifyParent.pipe(Effect.provide(settings));
      yield* notify(seeded.childThreadId, seeded.requestId);
      // A fresh notifier stands in for a restarted server re-seeing the same request.
      const restarted = yield* makeNotifyParent.pipe(Effect.provide(settings));
      yield* restarted(seeded.childThreadId, seeded.requestId);

      const notices = yield* childQuestionNotices(seeded.parentThreadId);
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.text, "Review the parser is waiting on the user");
      assert.include(notices[0]!.text, "Should I also fix the lexer?");
      assert.equal(notices[0]!.notification?.summary, "Review the parser has a question for you");
    }),
  );

  it.effect("stays quiet when the switch is off", () =>
    Effect.gen(function* () {
      const seeded = yield* seedChildWaitingOnUser({ name: "off", requestKind: "user_input" });
      const notify = yield* makeNotifyParent.pipe(
        Effect.provide(ServerSettingsService.layerTest({ wakeParentOnChildQuestion: false })),
      );
      yield* notify(seeded.childThreadId, seeded.requestId);
      assert.equal((yield* childQuestionNotices(seeded.parentThreadId)).length, 0);
    }),
  );

  it.effect("leaves the question to a blocking wait that still owns the task", () =>
    Effect.gen(function* () {
      const seeded = yield* seedChildWaitingOnUser({
        name: "blocking-wait",
        requestKind: "user_input",
        completionWake: "settled_only",
      });
      const notify = yield* makeNotifyParent.pipe(
        Effect.provide(ServerSettingsService.layerTest()),
      );
      yield* notify(seeded.childThreadId, seeded.requestId);
      assert.equal((yield* childQuestionNotices(seeded.parentThreadId)).length, 0);
    }),
  );

  it.effect("after startup recovery, tells the parent about a question that survived it", () =>
    Effect.gen(function* () {
      // Seeded without a live worker: the question persisted but its notice never went out.
      const seeded = yield* seedChildWaitingOnUser({ name: "restart", requestKind: "user_input" });
      const recover = Effect.gen(function* () {
        yield* (yield* ChildQuestionWake).notifyAfterRecovery;
      }).pipe(Effect.provide(ChildQuestionWakeLayer));
      yield* recover;
      // A second restart finds the earlier notice instead of posting again.
      yield* recover;
      const notices = yield* childQuestionNotices(seeded.parentThreadId);
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.text, "Should I also fix the lexer?");
    }),
  );

  it.effect("ignores auth refresh requests", () =>
    Effect.gen(function* () {
      const seeded = yield* seedChildWaitingOnUser({ name: "auth", requestKind: "auth_refresh" });
      const notify = yield* makeNotifyParent.pipe(
        Effect.provide(ServerSettingsService.layerTest()),
      );
      yield* notify(seeded.childThreadId, seeded.requestId);
      assert.equal((yield* childQuestionNotices(seeded.parentThreadId)).length, 0);
    }),
  );
});

it.layer(TestLayer)("restart continuation of a delegated child", (it) => {
  it.effect("delivers the continued child's result to its parent once, not the cancellation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const parentThreadId = ThreadId.make("thread:restart-child-parent");
      const childThreadId = ThreadId.make("thread:restart-child");
      const parentRunId = RunId.make("run:restart-child-parent");
      const cancelledRunId = RunId.make("run:restart-child-cancelled");
      const continuedRunId = RunId.make("run:restart-child-continued");
      const taskId = NodeId.make("node:restart-child-task");
      yield* seedParentWithTerminalTask({
        threadId: parentThreadId,
        projectId: ProjectId.make("project:restart-child"),
        runId: parentRunId,
        rootNodeId: NodeId.make("node:restart-child-root"),
        taskId,
        deliveryState: "claimed",
        now,
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const { completionDelivery: _completionDelivery, ...task } = parent.subagents[0]!;
      const childRun = {
        ...parent.runs[0]!,
        id: cancelledRunId,
        threadId: childThreadId,
        providerThreadId: null,
        userMessageId: MessageId.make("message:restart-child-user"),
        rootNodeId: null,
        delegatedCompletion: undefined,
        status: "cancelled" as const,
        completedAt: now,
      };
      // What restart recovery leaves behind: parent and child runs and the task record
      // cancelled under a reconcile command, which the live terminal-run listener ignores.
      const reconcileCommandId = CommandId.make("command:runtime-reconcile:shutdown:restart-child");
      yield* sink.write({
        commandId: reconcileCommandId,
        events: [
          {
            id: EventId.make("event:restart-child-parent-run"),
            type: "run.updated",
            threadId: parentThreadId,
            runId: parentRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...parent.runs[0]!, status: "cancelled", completedAt: now },
          },
          {
            id: EventId.make("event:restart-child-task"),
            type: "subagent.updated",
            threadId: parentThreadId,
            runId: parentRunId,
            nodeId: taskId,
            occurredAt: now,
            payload: { ...task, childThreadId, status: "cancelled", result: null },
          },
          {
            id: EventId.make("event:restart-child-thread"),
            type: "thread.created",
            threadId: childThreadId,
            occurredAt: now,
            payload: {
              ...parent.thread,
              id: childThreadId,
              title: "Fix the parser",
              lineage: {
                parentThreadId,
                relationshipToParent: "subagent",
                rootThreadId: parentThreadId,
              },
              forkedFrom: { type: "node", nodeId: taskId },
            },
          },
          {
            id: EventId.make("event:restart-child-cancelled-run"),
            type: "run.updated",
            threadId: childThreadId,
            runId: cancelledRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: childRun,
          },
        ],
      });
      // Without a pending continuation, the next start reports the cancellation to the parent.
      assert.include(yield* projections.getRecoveryThreadIds("subagent-results"), childThreadId);
      yield* sink.writeWithEffects({
        commandId: reconcileCommandId,
        events: [],
        effects: [
          {
            id: `effect:restart-continuation:${cancelledRunId}`,
            commandId: reconcileCommandId,
            threadId: childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: cancelledRunId },
          },
        ],
      });
      assert.notInclude(yield* projections.getRecoveryThreadIds("subagent-results"), childThreadId);

      const beforeContinuation = yield* sink.latestSequence();
      yield* sink.write({
        commandId: CommandId.make("command:restart-child-continued"),
        events: [
          {
            id: EventId.make("event:restart-child-continued-message"),
            type: "message.updated",
            threadId: childThreadId,
            runId: continuedRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-child-result"),
              threadId: childThreadId,
              runId: continuedRunId,
              nodeId: null,
              role: "assistant",
              text: "Parser fixed.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:restart-child-continued-run"),
            type: "run.updated",
            threadId: childThreadId,
            runId: continuedRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...childRun,
              id: continuedRunId,
              ordinal: 2,
              userMessageId: MessageId.make(`message:restart-continuation:${cancelledRunId}`),
              restartContinuationOfRunId: cancelledRunId,
              status: "completed",
            },
          },
        ],
      });
      // The terminal-run listener delivers asynchronously; its result transfer is the receipt.
      yield* sink
        .stream({
          threadId: parentThreadId,
          afterSequence: beforeContinuation,
          eventType: "context-transfer.created",
        })
        .pipe(Stream.take(1), Stream.runDrain);
      const settled = yield* orchestrator.getThreadProjection(parentThreadId);
      const transfers = settled.contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
      );
      assert.equal(transfers.length, 1);
      assert.equal(transfers[0]!.sourcePoint.runId, continuedRunId);
      const settledTask = settled.subagents.find((candidate) => candidate.id === taskId);
      assert.equal(settledTask?.status, "completed");
      assert.equal(settledTask?.result, "Parser fixed.");
      assert.equal(settledTask?.completionDelivery?.state, "claimed");
      assert.deepEqual(
        settled.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery?.taskIds,
        [taskId],
      );
      assert.notInclude(yield* projections.getRecoveryThreadIds("subagent-results"), childThreadId);
    }),
  );
});

/**
 * A parent whose idle delegated child already reported run 1. The seed is written under a
 * reconcile command, which the live terminal-run listener ignores, so only runs a test writes
 * afterwards are reacted to. `reported: false` leaves run 1's result undelivered.
 */
const seedReportedChild = (name: string, options: { readonly reported?: boolean } = {}) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const now = yield* DateTime.now;
    const parentThreadId = ThreadId.make(`thread:${name}-parent`);
    const childThreadId = ThreadId.make(`thread:${name}-child`);
    const parentRunId = RunId.make(`run:${name}-parent`);
    const taskId = NodeId.make(`node:${name}-task`);
    yield* seedParentWithTerminalTask({
      threadId: parentThreadId,
      projectId: ProjectId.make(`project:${name}`),
      runId: parentRunId,
      rootNodeId: NodeId.make(`node:${name}-root`),
      taskId,
      deliveryState: "delivered",
      completionWake: "always",
      now,
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    const { delegatedCompletion: _cohort, ...runFields } = parentRun;
    const childRun: OrchestrationV2Run = {
      ...runFields,
      threadId: childThreadId,
      providerThreadId: null,
      rootNodeId: null,
    };
    const commandId = CommandId.make(`command:runtime-reconcile:seed:${name}`);
    yield* sink.write({
      commandId,
      events: [
        {
          id: EventId.make(`event:${name}-parent-run`),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          // An idle parent whose cohort already spent its follow-up allowance.
          payload: {
            ...parentRun,
            status: "completed",
            completedAt: now,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 3,
              settledDeliveryCount: 2,
              delivery: null,
            },
          },
        },
        {
          id: EventId.make(`event:${name}-task`),
          type: "subagent.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: taskId,
          occurredAt: now,
          payload: { ...parent.subagents[0]!, childThreadId },
        },
        {
          id: EventId.make(`event:${name}-child-thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...parent.thread,
            id: childThreadId,
            title: "Fix the parser",
            lineage: {
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
          },
        },
        ...childTurnEvents({
          name,
          childThreadId,
          childRun,
          ordinal: 1,
          sender: parentThreadId,
          now,
        }),
        ...(options.reported === false
          ? []
          : [
              {
                id: EventId.make(`event:${name}-reported`),
                type: "context-transfer.created" as const,
                threadId: parentThreadId,
                runId: parentRunId,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: {
                  id: ContextTransferId.make(`context-transfer:${name}-reported`),
                  type: "subagent_result" as const,
                  sourceThreadId: childThreadId,
                  targetThreadId: parentThreadId,
                  sourcePoint: {
                    threadId: childThreadId,
                    runId: RunId.make(`run:${name}-child-1`),
                  },
                  basePoint: null,
                  sourceProviderInstanceId: modelSelection.instanceId,
                  targetProviderInstanceId: modelSelection.instanceId,
                  targetRunId: parentRunId,
                  status: "consumed" as const,
                  resolution: null,
                  createdBy: "system" as const,
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
      ],
    });
    /**
     * Writes a finished child turn; `sender` is the parent for turns the parent sent. A reconcile
     * command stands in for a turn that ended as the server stopped, before the listener saw it.
     */
    const finishTurn = (
      ordinal: number,
      sender: ThreadId | undefined,
      commandId = CommandId.make(`command:${name}-turn-${ordinal}`),
    ) =>
      sink.write({
        commandId,
        events: childTurnEvents({ name, childThreadId, childRun, ordinal, sender, now }),
      });
    return { parentThreadId, parentRun, childThreadId, parentRunId, taskId, finishTurn, commandId };
  });

function childTurnEvents(input: {
  readonly name: string;
  readonly childThreadId: ThreadId;
  readonly childRun: OrchestrationV2Run;
  readonly ordinal: number;
  readonly sender: ThreadId | undefined;
  readonly now: DateTime.Utc;
}) {
  const runId = RunId.make(`run:${input.name}-child-${input.ordinal}`);
  const userMessageId = MessageId.make(`message:${input.name}-ask-${input.ordinal}`);
  const message = (id: MessageId, role: "user" | "assistant", text: string) => ({
    id: EventId.make(`event:${id}`),
    type: "message.updated" as const,
    threadId: input.childThreadId,
    runId,
    occurredAt: input.now,
    payload: {
      id,
      threadId: input.childThreadId,
      runId,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdBy:
        role === "user" && input.sender === undefined ? ("user" as const) : ("agent" as const),
      creationSource:
        role === "user" && input.sender !== undefined ? ("mcp" as const) : ("web" as const),
      ...(role === "user" && input.sender !== undefined ? { senderThreadId: input.sender } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  return [
    message(userMessageId, "user", `Turn ${input.ordinal}, please.`),
    message(
      MessageId.make(`message:${input.name}-result-${input.ordinal}`),
      "assistant",
      `Result ${input.ordinal}.`,
    ),
    {
      id: EventId.make(`event:${input.name}-child-run-${input.ordinal}`),
      type: "run.updated" as const,
      threadId: input.childThreadId,
      runId,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: input.now,
      payload: {
        ...input.childRun,
        id: runId,
        ordinal: input.ordinal,
        userMessageId,
        status: "completed" as const,
        completedAt: input.now,
      },
    },
  ];
}

/** Waits for the parent's next result transfer, the receipt of a delivered child result. */
const nextResultTransfer = (parentThreadId: ThreadId, afterSequence: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    yield* sink
      .stream({ threadId: parentThreadId, afterSequence, eventType: "context-transfer.created" })
      .pipe(Stream.take(1), Stream.runDrain);
  });

const reportedRuns = (parentThreadId: ThreadId, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const parent = yield* (yield* OrchestratorV2).getThreadProjection(parentThreadId);
    return parent.contextTransfers
      .filter(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
      )
      .map((transfer) => transfer.sourcePoint.runId);
  });

it.layer(TestLayer)("resumed delegated child", (it) => {
  it.effect("a turn the parent sends reports back and wakes the parent once", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const seeded = yield* seedReportedChild("resumed-sent");
      const before = yield* sink.latestSequence();
      yield* seeded.finishTurn(2, seeded.parentThreadId);
      yield* nextResultTransfer(seeded.parentThreadId, before);

      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        RunId.make("run:resumed-sent-child-1"),
        RunId.make("run:resumed-sent-child-2"),
      ]);
      const parent = yield* (yield* OrchestratorV2).getThreadProjection(seeded.parentThreadId);
      const task = parent.subagents.find((candidate) => candidate.id === seeded.taskId);
      assert.equal(task?.result, "Result 2.");
      assert.equal(task?.completionDelivery?.state, "claimed");
      // The spent cohort reopens with a fresh allowance and one wake for this task.
      const cohort = parent.runs.find((run) => run.id === seeded.parentRunId)?.delegatedCompletion;
      assert.equal(cohort?.settledDeliveryCount, 0);
      assert.deepEqual(cohort?.delivery?.taskIds, [seeded.taskId]);
      // Delivered once: a restart does not report it again.
      assert.notInclude(
        yield* projections.getRecoveryThreadIds("subagent-results"),
        seeded.childThreadId,
      );
    }),
  );

  it.effect("a turn the user starts in the child does not report back", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const seeded = yield* seedReportedChild("resumed-typed");
      yield* seeded.finishTurn(2, undefined);
      assert.notInclude(
        yield* projections.getRecoveryThreadIds("subagent-results"),
        seeded.childThreadId,
      );
      // Terminal runs are handled in order, so turn 3's report proves turn 2 was passed over.
      const before = yield* sink.latestSequence();
      yield* seeded.finishTurn(3, seeded.parentThreadId);
      yield* nextResultTransfer(seeded.parentThreadId, before);
      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        RunId.make("run:resumed-typed-child-1"),
        RunId.make("run:resumed-typed-child-3"),
      ]);
    }),
  );

  it.effect("a restart recovers an unreported turn only while the parent has not moved on", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const seeded = yield* seedReportedChild("resumed-restart");
      yield* seeded.finishTurn(2, seeded.parentThreadId, seeded.commandId);
      assert.include(
        yield* projections.getRecoveryThreadIds("subagent-results"),
        seeded.childThreadId,
      );
      const later = DateTime.add(yield* DateTime.now, { minutes: 1 });
      const laterRunId = RunId.make("run:resumed-restart-parent-later");
      yield* sink.write({
        commandId: seeded.commandId,
        events: [
          {
            id: EventId.make("event:resumed-restart-parent-later"),
            type: "run.updated",
            threadId: seeded.parentThreadId,
            runId: laterRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: later,
            payload: {
              ...seeded.parentRun,
              id: laterRunId,
              ordinal: 2,
              status: "completed",
              requestedAt: later,
              completedAt: later,
              delegatedCompletion: undefined,
            },
          },
        ],
      });
      // A stale result from before an upgrade or long outage does not wake a parent that carried on.
      assert.notInclude(
        yield* projections.getRecoveryThreadIds("subagent-results"),
        seeded.childThreadId,
      );
    }),
  );

  it.effect("with the switch off, only the first result reports back", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const settings = yield* ServerSettingsService;
      const resumed = yield* seedReportedChild("resumed-off");
      const firstReport = yield* seedReportedChild("resumed-off-first", { reported: false });
      yield* settings.updateSettings({ wakeParentOnResumedChild: false });
      yield* Effect.gen(function* () {
        const before = yield* sink.latestSequence();
        yield* resumed.finishTurn(2, resumed.parentThreadId);
        // A first result still reports; handled after turn 2, it is that turn's receipt.
        yield* firstReport.finishTurn(2, firstReport.parentThreadId);
        yield* nextResultTransfer(firstReport.parentThreadId, before);
        assert.deepEqual(yield* reportedRuns(resumed.parentThreadId, resumed.childThreadId), [
          RunId.make("run:resumed-off-child-1"),
        ]);
      }).pipe(
        Effect.ensuring(
          settings.updateSettings({ wakeParentOnResumedChild: true }).pipe(Effect.ignore),
        ),
      );
    }),
  );
});
