import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
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
import { TestClock } from "effect/testing";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
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
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
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
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
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

it.layer(TestLayer)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
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

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      // A restart cut the spawning run; its continuation is the live run now.
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
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
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
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
      const orchestrator = yield* Orchestrator.OrchestratorV2;
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
        const orchestrator = yield* Orchestrator.OrchestratorV2;
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

// Runtime reconciliation writes restart cancellations under this command
// prefix, which the live terminal-run listener skips.
const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

/** A running app-owned task whose child thread's first run the restart cancelled. */
const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  /** "completed" seeds a settled turn whose background work the restart cancelled. */
  readonly runStatus?: "cancelled" | "completed";
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        runEvent({
          threadId: childThreadId,
          runId: childRunId,
          ordinal: 1,
          status: input.runStatus ?? "cancelled",
          now: input.now,
        }),
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

it.layer(TestLayer)("delegated tasks across a server restart", (it) => {
  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const stopped = yield* child("restart-stopped-child", false);
      // Settled with only background work left: its interim reply is not the result.
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      // A second restart cut the first continuation before it started.
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      // A replayed first continuation settling must not release the second one's hold.
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      // A caller that read the cancelled run before the child resumed sees it as pending.
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      // The continuation's own run finishing settles the task with its result.
      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  // A running provider turn does not prove the provider consumed the delivery
  // (Claude marks the turn running before it reads the prompt), so a cut
  // delivery is offered again even when a continuation resumes that turn.
  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      // The restart cut the turn blocked in delegate_task(wait); its
      // continuation is a new, live run.
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
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
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
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
    const sink = yield* EventSink.EventSinkV2;
    yield* sink
      .stream({ threadId: parentThreadId, afterSequence, eventType: "context-transfer.created" })
      .pipe(Stream.take(1), Stream.runDrain);
  });

const reportedRuns = (parentThreadId: ThreadId, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(parentThreadId);
    return parent.contextTransfers
      .filter(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
      )
      .map((transfer) => transfer.sourcePoint.runId);
  });

it.layer(TestLayer)("resumed delegated child", (it) => {
  it.effect("reports a parent's follow-up from its later background wake turn exactly once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const seeded = yield* seedReportedChild("resumed-background");
      const child = yield* orchestrator.getThreadProjection(seeded.childThreadId);
      const now = yield* DateTime.now;
      const command = {
        id: TurnItemId.make("item:resumed-background-command"),
        threadId: seeded.childThreadId,
        runId: RunId.make("run:resumed-background-child-2"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "command_execution" as const,
        status: "running" as const,
        title: "Build",
        input: "make build",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const writeCommand = (status: "running" | "completed") =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:resumed-background-command-${status}`),
              type: "turn-item.updated",
              threadId: seeded.childThreadId,
              occurredAt: now,
              payload: { ...command, status },
            },
          ],
        });
      yield* writeCommand("running");
      yield* seeded.finishTurn(2, seeded.parentThreadId, seeded.commandId);
      yield* orchestrator.recoverDelegatedTasks;
      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        child.runs[0]!.id,
      ]);
      const before = yield* sink.latestSequence();
      yield* writeCommand("completed");
      // The background notification has no sender, but the parent's run 2 request is still owed.
      yield* seeded.finishTurn(3, undefined);
      yield* nextResultTransfer(seeded.parentThreadId, before);
      yield* orchestrator.recoverDelegatedTasks;
      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        child.runs[0]!.id,
        RunId.make("run:resumed-background-child-3"),
      ]);
      const parent = yield* orchestrator.getThreadProjection(seeded.parentThreadId);
      assert.equal(parent.subagents[0]?.result, "Result 3.");
      assert.deepEqual(parent.runs[0]?.delegatedCompletion?.delivery?.taskIds, [seeded.taskId]);
    }),
  );

  it.effect("a turn the parent sends reports back and wakes the parent once", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const seeded = yield* seedReportedChild("resumed-sent");
      const before = yield* sink.latestSequence();
      yield* seeded.finishTurn(2, seeded.parentThreadId);
      yield* nextResultTransfer(seeded.parentThreadId, before);

      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        RunId.make("run:resumed-sent-child-1"),
        RunId.make("run:resumed-sent-child-2"),
      ]);
      const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        seeded.parentThreadId,
      );
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

  it.effect("records a resumed result without reopening delivery disposed after the request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const seeded = yield* seedReportedChild("resumed-disposed");
      yield* seeded.finishTurn(2, seeded.parentThreadId, seeded.commandId);
      yield* TestClock.adjust("1 millis");
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make("command:resumed-dispose"),
        parentThreadId: seeded.parentThreadId,
        taskId: seeded.taskId,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const parent = yield* orchestrator.getThreadProjection(seeded.parentThreadId);
      assert.equal(parent.subagents[0]?.result, "Result 2.");
      assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
      assert.deepEqual(yield* reportedRuns(seeded.parentThreadId, seeded.childThreadId), [
        RunId.make("run:resumed-disposed-child-1"),
        RunId.make("run:resumed-disposed-child-2"),
      ]);
    }),
  );

  it.effect("a turn the user starts in the child does not report back", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
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
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
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
});

const seedChildWaitingOnUser = (input: {
  readonly name: string;
  readonly requestKind: "user_input" | "auth_refresh";
  /** settled_only with the parent run active is a blocking delegate_task wait. */
  readonly completionWake?: "always" | "settled_only";
}) =>
  Effect.gen(function* () {
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
    yield* sink.write({
      commandId: CommandId.make(`command:runtime-reconcile:seed-child-question:${input.name}`),
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
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    return parent.messages.filter((message) =>
      String(message.id).startsWith("message:child-question:"),
    );
  });

it.layer(TestLayer)("child question wake", (it) => {
  it.effect(
    "recovers a pending child question once, while blocking waits and auth stay quiet",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const question = yield* seedChildWaitingOnUser({
          name: "recovery",
          requestKind: "user_input",
        });
        const blocking = yield* seedChildWaitingOnUser({
          name: "blocking",
          requestKind: "user_input",
          completionWake: "settled_only",
        });
        const auth = yield* seedChildWaitingOnUser({ name: "auth", requestKind: "auth_refresh" });
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const notices = yield* childQuestionNotices(question.parentThreadId);
        assert.equal(notices.length, 1);
        assert.include(notices[0]!.text, "Should I also fix the lexer?");
        assert.equal(notices[0]!.notification?.summary, "Review the parser has a question for you");
        assert.equal((yield* childQuestionNotices(blocking.parentThreadId)).length, 0);
        assert.equal((yield* childQuestionNotices(auth.parentThreadId)).length, 0);
      }),
  );
});
