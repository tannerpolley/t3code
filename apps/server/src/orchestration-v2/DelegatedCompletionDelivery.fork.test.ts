import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { runtimeRequestIsOwnerVisible } from "@t3tools/shared/delegatedRequestVisibility";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { completionCohort } from "./ForkDelegatedCompletion.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  childQuestionNotices,
  childQuestionWake,
  endParentRuns,
  layerTest,
  ownerCanSee,
  reconcileCommandId,
  seedChildWaitingOnUser,
  seedParentWithTerminalTask,
  wakeChildQuestion,
} from "./DelegatedCompletionDelivery.testHarness.ts";

// Run-less managed admissions keep their cohort on the parent thread; ordinary delegation keeps it on the run.
const cohortOwners = ["run", "thread"] as const;
type CohortOwner = (typeof cohortOwners)[number];

const seedOwnedParent = Effect.fn("seedOwnedParent")(function* (
  owner: CohortOwner,
  name: string,
  input: {
    readonly deliveryState: "delivered" | "claimed";
    readonly withDelivery: boolean;
    readonly parentRunEnded: boolean;
    readonly disposition?: "open" | "stopped";
  },
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const key = `${owner}-owned-${name}`;
  const threadId = ThreadId.make(`thread:${key}`);
  const runId = RunId.make(`run:${key}`);
  const taskId = NodeId.make(`task:${key}`);
  yield* seedParentWithTerminalTask({
    threadId,
    projectId: ProjectId.make(`project:${key}`),
    runId,
    rootNodeId: NodeId.make(`root:${key}`),
    taskId,
    deliveryState: input.deliveryState,
    completionWake: "always",
    ...(input.withDelivery ? { deliveryTaskIds: [taskId] } : {}),
    now,
  });
  const seeded = yield* engine.getThreadProjection(threadId);
  const run = seeded.runs[0]!;
  const parentRunId = owner === "run" ? runId : null;
  const cohort = { ...run.delegatedCompletion!, disposition: input.disposition ?? "open" };
  yield* sink.write({
    commandId: reconcileCommandId(`${key}-owner`),
    events: [
      ...(owner === "thread"
        ? [
            {
              id: EventId.make(`${key}-thread-cohort`),
              type: "thread.metadata-updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...seeded.thread, delegatedCompletion: cohort },
            },
          ]
        : []),
      {
        id: EventId.make(`${key}-parent-run`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...run,
          ...(input.parentRunEnded
            ? {
                status: input.disposition === "stopped" ? "interrupted" : "completed",
                completedAt: now,
              }
            : {}),
          delegatedCompletion:
            owner === "run" ? cohort : { disposition: "open", nextGeneration: 1, delivery: null },
        },
      },
      {
        id: EventId.make(`${key}-task-owner`),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: { ...seeded.subagents[0]!, runId: parentRunId },
      },
    ],
  });
  return {
    key,
    threadId,
    runId,
    taskId,
    parentRunId,
    now,
    thread: seeded.thread,
    run,
    task: seeded.subagents[0]!,
    messageId: MessageId.make(`message:delegated-delivery:${threadId}`),
    cohortOf: (projection: Parameters<typeof completionCohort>[0]) =>
      completionCohort(projection, parentRunId),
  };
});

/** Events for a worker of `parent` whose run ended with `text`, committed before any listener saw them. */
const finishedWorkerEvents = (
  parent: Effect.Success<ReturnType<typeof seedOwnedParent>>,
  name: string,
  text: string,
  options?: { readonly status?: "failed"; readonly routine?: boolean },
) => {
  const childThreadId = ThreadId.make(`thread:${parent.key}-${name}`);
  const childRunId = RunId.make(`run:${parent.key}-${name}`);
  const task = {
    ...parent.task,
    id: NodeId.make(`task:${parent.key}-${name}`),
    runId: parent.parentRunId,
    childThreadId,
    status: "running" as const,
    result: null,
    completedAt: null,
    ...(options?.routine === true ? { batchCompletion: true } : {}),
    completionDelivery: { state: "pending" as const, observedByRunId: null },
  };
  const { now } = parent;
  return {
    task,
    events: [
      {
        id: EventId.make(`${parent.key}-${name}-created`),
        type: "thread.created" as const,
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...parent.thread,
          id: childThreadId,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: parent.threadId,
            rootThreadId: parent.threadId,
            relationshipToParent: "subagent" as const,
          },
          forkedFrom: { type: "node" as const, nodeId: task.id },
        },
      },
      {
        id: EventId.make(`${parent.key}-${name}-task`),
        type: "subagent.updated" as const,
        threadId: parent.threadId,
        occurredAt: now,
        payload: task,
      },
      {
        id: EventId.make(`${parent.key}-${name}-result`),
        type: "message.updated" as const,
        threadId: childThreadId,
        runId: childRunId,
        occurredAt: now,
        payload: {
          id: MessageId.make(`message:${parent.key}-${name}-result`),
          threadId: childThreadId,
          runId: childRunId,
          nodeId: null,
          role: "assistant" as const,
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`${parent.key}-${name}-ended`),
        type: "run.updated" as const,
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...parent.run,
          id: childRunId,
          threadId: childThreadId,
          userMessageId: MessageId.make(`message:${parent.key}-${name}`),
          providerThreadId: null,
          rootNodeId: null,
          delegatedTaskId: task.id,
          delegatedCompletion: { disposition: "open" as const, nextGeneration: 1, delivery: null },
          status: options?.status ?? ("completed" as const),
          completedAt: now,
        },
      },
    ] as const,
  };
};

it.layer(
  ProviderContinuationService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerTest, IdAllocator.layer, ProviderContinuationRequests.layer),
    ),
  ),
)("routine delegated completion batching", (it) => {
  it.effect.each(["deadline", "failure", "immediate result", "stop"] as const)(
    "uses one delivery when the batch ends by %s",
    (end) =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const parent = yield* seedOwnedParent("run", `batch-${end}`, {
          deliveryState: "delivered",
          withDelivery: false,
          parentRunEnded: true,
        });
        const first = finishedWorkerEvents(parent, "first", "First check passed.", {
          routine: true,
        });
        yield* sink.write({ events: first.events });
        yield* engine.recoverDelegatedTask(first.task.childThreadId);

        yield* TestClock.adjust("10 seconds");
        const second = finishedWorkerEvents(parent, "second", "Second check reported.", {
          ...(end === "failure" ? { status: "failed" } : {}),
          routine: end !== "immediate result",
        });
        const before = yield* engine.getThreadProjection(parent.threadId);
        assert.isEmpty(
          before.messages.filter((message) => message.delegatedCompletion !== undefined),
        );
        const delivery = parent.cohortOf(before)?.delivery;
        assert.isDefined(delivery?.dispatchAfterMs);
        const stored = yield* sink.write({ events: second.events });
        const sequence = stored.at(-1)!.sequence;
        yield* engine.recoverDelegatedTask(second.task.childThreadId);

        if (end === "stop") {
          yield* engine.dispatch({
            type: "thread.stop",
            commandId: reconcileCommandId(`${parent.key}-stop`),
            threadId: parent.threadId,
          });
          yield* TestClock.adjust("15 seconds");
          const stopped = yield* engine.getThreadProjection(parent.threadId);
          assert.isEmpty(
            stopped.messages.filter((message) => message.delegatedCompletion !== undefined),
          );
          return;
        }
        if (end === "deadline") {
          yield* engine.recoverDelegatedTasks;
          yield* TestClock.adjust("4999 millis");
          const waiting = yield* engine.getThreadProjection(parent.threadId);
          assert.isEmpty(
            waiting.messages.filter((message) => message.delegatedCompletion !== undefined),
          );
          yield* TestClock.adjust("1 millis");
        }
        yield* sink.stream({ afterSequence: sequence, eventType: "run.created" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.created" && event.payload.userMessageId === delivery?.messageId,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* TestClock.adjust("15 seconds");
        const after = yield* engine.getThreadProjection(parent.threadId);
        const wakes = after.messages.filter((message) => message.delegatedCompletion !== undefined);
        assert.lengthOf(wakes, 1);
        assert.deepEqual(wakes[0]?.delegatedCompletion?.taskIds, [first.task.id, second.task.id]);
        assert.equal(wakes[0]?.delegatedCompletion?.containsFailure, end === "failure");
        if (end === "deadline") assert.equal(wakes[0]?.delegatedCompletion?.batched, true);
        assert.include(wakes[0]?.text, "First check passed.");
        assert.include(wakes[0]?.text, "Second check reported.");
        const wakeRuns = after.runs.filter((run) => run.userMessageId === wakes[0]?.id);
        assert.lengthOf(wakeRuns, 1);
        if (end !== "deadline") return;

        const wake = wakeRuns[0]!;
        const now = yield* DateTime.now;
        const replyId = MessageId.make(`message:${parent.key}-batch-reply`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(replyId),
              type: "message.updated",
              threadId: parent.threadId,
              runId: wake.id,
              occurredAt: now,
              payload: {
                id: replyId,
                threadId: parent.threadId,
                runId: wake.id,
                nodeId: wake.rootNodeId,
                role: "assistant",
                text: "Both checks completed.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`event:${parent.key}-batch-ended`),
              type: "run.updated",
              threadId: parent.threadId,
              runId: wake.id,
              occurredAt: now,
              payload: { ...wake, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* engine.recoverDelegatedTasks;
        yield* engine.dispatch({
          type: "run.silence.check",
          commandId: reconcileCommandId(`${parent.key}-silence-check`),
          threadId: parent.threadId,
          runId: wake.id,
        });
        const settled = yield* engine.getThreadProjection(parent.threadId);
        assert.isNull(parent.cohortOf(settled)?.delivery);
        assert.equal(settled.runs.length, after.runs.length);
        assert.isFalse(
          settled.messages.some((message) => message.silentWakeFollowupOfRunId !== undefined),
        );
      }),
  );
});

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "completion recovery for both cohort owners",
  (it) => {
    it.effect("leaves the parent's completion reservation behind when starting a reviewer", () =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const parent = yield* seedOwnedParent("thread", "start-reviewer", {
          deliveryState: "claimed",
          withDelivery: true,
          parentRunEnded: false,
        });
        const rootNodeId = parent.run.rootNodeId!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:start-reviewer-root"),
              type: "node.updated",
              threadId: parent.threadId,
              runId: parent.runId,
              nodeId: rootNodeId,
              occurredAt: parent.now,
              payload: {
                id: rootNodeId,
                threadId: parent.threadId,
                runId: parent.runId,
                parentNodeId: null,
                rootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: parent.run.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: parent.now,
                completedAt: null,
              },
            },
          ],
        });
        const { storedEvents } = yield* engine.dispatch({
          type: "delegated_task.request",
          commandId: reconcileCommandId("start-reviewer"),
          parentThreadId: parent.threadId,
          parentRunId: parent.runId,
          parentNodeId: rootNodeId,
          role: "reviewer",
          task: "Review the patch.",
          modelSelection: parent.thread.modelSelection,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
          createdBy: "agent",
          creationSource: "server",
        });
        const created = storedEvents.find(({ event }) => event.type === "thread.created")?.event;
        assert.isDefined(created);
        if (created?.type !== "thread.created") return;
        assert.isUndefined(created.payload.delegatedCompletion);
        const after = yield* engine.getThreadProjection(parent.threadId);
        assert.deepEqual(parent.cohortOf(after)?.delivery?.taskIds, [parent.taskId]);
        yield* engine.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: reconcileCommandId(`${parent.key}-dispose`),
          parentThreadId: parent.threadId,
          taskId: parent.taskId,
        });
      }),
    );

    it.effect.each(["dispatch", "recovery", "queue resume"] as const)(
      "drops a copied completion reservation at %s without waking the reviewer",
      (path) =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const parent = yield* seedOwnedParent("thread", `copied-wake-${path}`, {
            deliveryState: "claimed",
            withDelivery: true,
            parentRunEnded: true,
          });
          const before = yield* engine.getThreadProjection(parent.threadId);
          const worker = finishedWorkerEvents(parent, "reviewer", "Review complete.");
          const child = worker.events[0];
          yield* sink.write({
            events: [
              {
                ...child,
                payload: { ...child.payload, delegatedCompletion: parent.cohortOf(before)! },
              },
            ],
          });
          using offer = vi.spyOn(requests, "offer").mockReturnValue(Effect.void);
          if (path === "dispatch") {
            yield* engine.dispatch({
              type: "message.dispatch",
              commandId: reconcileCommandId(`${parent.key}-wake`),
              threadId: child.threadId,
              messageId: parent.messageId,
              text: "Issue worker finished.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: { parentRunId: null, generation: 1, taskIds: [parent.taskId] },
              createdBy: "agent",
              creationSource: "server",
            });
          } else if (path === "recovery") {
            yield* engine.recoverDelegatedTasks;
            const recipients = offer.mock.calls.map(([request]) => request.threadId);
            assert.include(recipients, parent.threadId);
            assert.notInclude(recipients, child.threadId);
          } else {
            const { payload: finished } = worker.events[3];
            yield* sink.write({
              events: [
                {
                  ...worker.events[2],
                  payload: {
                    ...worker.events[2].payload,
                    id: parent.messageId,
                    role: "user",
                    delegatedCompletion: {
                      parentRunId: null,
                      generation: 1,
                      taskIds: [parent.taskId],
                    },
                  },
                },
                {
                  ...worker.events[3],
                  payload: {
                    ...finished,
                    userMessageId: parent.messageId,
                    status: "queued",
                    startedAt: null,
                    completedAt: null,
                  },
                },
              ],
            });
            yield* engine.resumeQueuedRuns;
          }
          const reviewer = yield* engine.getThreadProjection(child.threadId);
          if (path === "queue resume") {
            assert.deepEqual(
              reviewer.runs.map((run) => run.status),
              ["cancelled"],
            );
          } else {
            assert.isEmpty(reviewer.messages);
            assert.isEmpty(reviewer.runs);
          }
          assert.isNull(reviewer.thread.delegatedCompletion?.delivery);
          const after = yield* engine.getThreadProjection(parent.threadId);
          assert.deepEqual(parent.cohortOf(after), parent.cohortOf(before));
          assert.deepEqual(after.subagents, before.subagents);
          yield* engine.dispatch({
            type: "delegated_task.completion-delivery.dispose",
            commandId: reconcileCommandId(`${parent.key}-dispose`),
            parentThreadId: parent.threadId,
            taskId: parent.taskId,
          });
        }),
    );

    it.effect.each(cohortOwners)(
      "reoffers a committed %s-owned completion during targeted checkpoint recovery",
      (owner) =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const parent = yield* seedOwnedParent(owner, "targeted-recovery", {
            deliveryState: "delivered",
            withDelivery: false,
            parentRunEnded: true,
          });
          const worker = finishedWorkerEvents(parent, "worker", "Saved result.");
          yield* sink.write({
            commandId: reconcileCommandId(`${parent.key}-child-finished`),
            events: worker.events,
          });
          using offer = vi.spyOn(requests, "offer").mockReturnValueOnce(Effect.void);
          yield* engine.recoverDelegatedTask(worker.task.childThreadId);
          const before = yield* engine.getThreadProjection(parent.threadId);
          assert.equal(
            before.subagents.find((task) => task.id === worker.task.id)?.result,
            "Saved result.",
          );
          assert.lengthOf(offer.mock.calls, 1);
          assert.isTrue(
            yield* projections.hasPendingDelegatedCompletion(worker.task.childThreadId),
          );
          yield* engine.recoverDelegatedTask(worker.task.childThreadId);
          assert.lengthOf(offer.mock.calls, 2);
          const request = yield* requests.take;
          assert.equal(request.delegatedCompletion?.parentRunId, parent.parentRunId);
          assert.equal(
            request.delegatedCompletion?.messageId,
            parent.cohortOf(before)?.delivery?.messageId,
          );
          yield* engine.dispatch({
            type: "delegated_task.completion-delivery.dispose",
            commandId: CommandId.make(`dispose:${parent.key}`),
            parentThreadId: parent.threadId,
            taskId: worker.task.id,
          });
          assert.isFalse(
            yield* projections.hasPendingDelegatedCompletion(worker.task.childThreadId),
          );
        }),
    );

    it.effect.each(cohortOwners)(
      "names and links the saved result for a failed %s-owned wake, and clears it on Stop",
      (owner) =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const parent = yield* seedOwnedParent(owner, "dispatch-attention", {
            deliveryState: "claimed",
            withDelivery: true,
            parentRunEnded: true,
          });
          const sink = yield* EventSink.EventSinkV2;
          const saved = finishedWorkerEvents(parent, "saved-result", "Review complete");
          const child = {
            ...saved.events[0]!,
            payload: { ...saved.events[0]!.payload, title: "Review the patch" },
          };
          yield* sink.write({
            commandId: reconcileCommandId(`${parent.key}-result-thread`),
            events: [
              child,
              {
                id: EventId.make(`${parent.key}-task-result-thread`),
                type: "subagent.updated",
                threadId: parent.threadId,
                occurredAt: parent.now,
                payload: {
                  ...parent.task,
                  runId: parent.parentRunId,
                  childThreadId: child.threadId,
                },
              },
            ],
          });
          const command = {
            type: "delegated_task.completion-delivery.flag" as const,
            commandId: CommandId.make(`flag:${parent.key}`),
            threadId: parent.threadId,
            parentRunId: parent.parentRunId,
            generation: 1,
            messageId: parent.messageId,
          };
          assert.isEmpty(
            (yield* engine.dispatch({
              ...command,
              commandId: CommandId.make(`stale-generation:${parent.key}`),
              generation: 2,
            })).storedEvents,
          );
          assert.lengthOf((yield* engine.dispatch(command)).storedEvents, 1);
          assert.isTrue((yield* engine.dispatch(command)).replayed);
          const flagged = yield* engine.getThreadProjection(parent.threadId);
          assert.include(flagged.thread.silentWakeAttention, {
            deliveryMessageId: parent.messageId,
            resultThreadId: child.threadId,
          });
          assert.include(flagged.thread.silentWakeAttention?.reason, child.payload.title);
          assert.isNotNull(flagged.subagents[0]?.result);
          yield* engine.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`stop:${parent.key}`),
            threadId: parent.threadId,
          });
          assert.isEmpty(
            (yield* engine.dispatch({
              ...command,
              commandId: CommandId.make(`after-stop:${parent.key}`),
            })).storedEvents,
          );
          const stopped = yield* engine.getThreadProjection(parent.threadId);
          assert.isUndefined(stopped.thread.silentWakeAttention);
          assert.deepEqual(stopped.subagents[0]?.result, flagged.subagents[0]?.result);
        }),
    );

    it.effect.each(cohortOwners)(
      "restart recovery adds a second worker to a queued %s-owned delivery and settles both",
      (owner) =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          // The result and reservation committed, but no continuation was dispatched before shutdown.
          const parent = yield* seedOwnedParent(owner, "recovery", {
            deliveryState: "claimed",
            withDelivery: true,
            parentRunEnded: true,
          });
          const { threadId, taskId, messageId, parentRunId, now } = parent;
          yield* sink.write({
            commandId: reconcileCommandId(`${parent.key}-busy`),
            events: [
              {
                id: EventId.make(`${parent.key}-busy-parent`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...parent.run,
                  id: RunId.make(`run:${parent.key}-busy-parent`),
                  ordinal: 2,
                  userMessageId: MessageId.make(`message:${parent.key}-busy-parent`),
                  rootNodeId: null,
                  delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
                },
              },
            ],
          });
          const offer = vi.spyOn(requests, "offer");
          yield* Effect.gen(function* () {
            yield* engine.recoverDelegatedTasks;
            assert.equal(offer.mock.calls.length, 1);
            assert.deepEqual(offer.mock.calls[0]![0].delegatedCompletion, {
              parentRunId,
              generation: 1,
              messageId,
            });
            yield* engine.dispatch({
              type: "delegated_task.completion-delivery.flag",
              commandId: CommandId.make(`flag:${parent.key}`),
              threadId,
              parentRunId,
              generation: 1,
              messageId,
            });
            yield* engine.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${parent.key}-delivery`),
              threadId,
              messageId,
              text: "Issue worker finished.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: { parentRunId, generation: 1, taskIds: [taskId] },
              createdBy: "agent",
              creationSource: "server",
            });
            const dispatched = yield* engine.getThreadProjection(threadId);
            const deliveryRun = dispatched.runs.find(
              (candidate) => candidate.userMessageId === messageId,
            )!;
            assert.equal(deliveryRun.status, "queued");
            // A sibling finished while the server was down: its result is published at restart.
            const second = finishedWorkerEvents(
              parent,
              "second-worker",
              "Second issue worker result.",
            );
            yield* sink.write({
              commandId: reconcileCommandId(`${parent.key}-second-worker-finished`),
              events: second.events,
            });
            yield* engine.recoverDelegatedTasks;
            const coalesced = yield* engine.getThreadProjection(threadId);
            assert.deepEqual(parent.cohortOf(coalesced)?.delivery, {
              generation: 1,
              messageId,
              taskIds: [taskId, second.task.id],
            });
            const message = coalesced.messages.find((candidate) => candidate.id === messageId)!;
            assert.deepEqual(message.delegatedCompletion?.taskIds, [taskId, second.task.id]);
            assert.include(message.text, "child finished");
            assert.include(message.text, "Second issue worker result.");
            // This delivery also ended before startup's terminal-run listener was attached.
            yield* sink.write({
              commandId: reconcileCommandId(`${parent.key}-delivery-ended`),
              events: [
                {
                  id: EventId.make(`${parent.key}-delivery-ended`),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...deliveryRun, status: "completed", completedAt: now },
                },
              ],
            });
            yield* engine.recoverDelegatedTasks;
            // A further restart finds nothing left to deliver.
            yield* engine.recoverDelegatedTasks;
            const settled = yield* engine.getThreadProjection(threadId);
            assert.isNull(parent.cohortOf(settled)?.delivery);
            assert.isUndefined(settled.thread.silentWakeAttention);
            for (const id of [taskId, second.task.id]) {
              assert.equal(
                settled.subagents.find((candidate) => candidate.id === id)?.completionDelivery
                  ?.state,
                "delivered",
              );
            }
            assert.equal(
              settled.subagents.find((candidate) => candidate.id === taskId)?.result,
              "child finished",
            );
            assert.lengthOf(
              settled.messages.filter((candidate) => candidate.delegatedCompletion !== undefined),
              1,
            );
            assert.equal(offer.mock.calls.length, 1);
          }).pipe(Effect.ensuring(Effect.sync(() => offer.mockRestore())));
        }),
    );

    it.effect.each(
      cohortOwners.flatMap((owner) =>
        (["observed", "late"] as const).map((read) => ({ owner, read })),
      ),
    )(
      "a $read result read of a $owner-owned task settles its queued wake only when seen",
      ({ owner, read }) =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const parent = yield* seedOwnedParent(owner, `read-${read}`, {
            deliveryState: "claimed",
            withDelivery: true,
            parentRunEnded: false,
          });
          const { threadId, taskId, messageId, parentRunId } = parent;
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${parent.key}-delivery`),
            threadId,
            messageId,
            text: "Issue worker finished.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            delegatedCompletion: { parentRunId, generation: 1, taskIds: [taskId] },
            createdBy: "agent",
            creationSource: "server",
          });
          const wakeRunId = (yield* engine.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.userMessageId === messageId,
          )!.id;
          // A late wait ends after its turn did, so no run saw the result it returned.
          yield* engine.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`${parent.key}-acknowledge`),
            parentThreadId: threadId,
            taskId,
            observedByRunId: read === "observed" ? parent.runId : null,
          });
          const after = yield* engine.getThreadProjection(threadId);
          const task = after.subagents.find((candidate) => candidate.id === taskId)!;
          const wakeRun = after.runs.find((candidate) => candidate.id === wakeRunId)!;
          if (read === "observed") {
            assert.equal(task.completionDelivery?.state, "acknowledged");
            assert.isNull(parent.cohortOf(after)?.delivery);
            assert.equal(wakeRun.status, "cancelled");
          } else {
            assert.equal(task.completionDelivery?.state, "claimed");
            assert.deepEqual(parent.cohortOf(after)?.delivery?.taskIds, [taskId]);
            assert.equal(wakeRun.status, "queued");
          }
        }),
    );

    it.effect.each(
      cohortOwners.flatMap((owner) =>
        (["archived", "deleted", "stopped"] as const).map((closure) => ({ owner, closure })),
      ),
    )("a $owner-owned worker that finishes after its parent was $closure", ({ owner, closure }) =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        // A thread cohort marked stopped is the pre-#418 format: the whole mailbox stopped.
        const parent = yield* seedOwnedParent(owner, `closed-${closure}`, {
          deliveryState: "delivered",
          withDelivery: false,
          parentRunEnded: true,
          disposition: closure === "stopped" ? "stopped" : "open",
        });
        const worker = finishedWorkerEvents(parent, "worker", "Worker result.");
        const closed = yield* engine.getThreadProjection(parent.threadId);
        yield* sink.write({
          commandId: reconcileCommandId(`${parent.key}-worker-finished`),
          events: [
            ...worker.events,
            ...(closure === "stopped"
              ? []
              : [
                  {
                    id: EventId.make(`${parent.key}-closed`),
                    type: "thread.metadata-updated" as const,
                    threadId: parent.threadId,
                    occurredAt: parent.now,
                    payload: {
                      ...closed.thread,
                      ...(closure === "archived"
                        ? { archivedAt: parent.now }
                        : { deletedAt: parent.now }),
                    },
                  },
                ]),
          ],
        });
        const offer = vi.spyOn(requests, "offer");
        yield* Effect.gen(function* () {
          yield* engine.recoverDelegatedTasks;
          const after = yield* projections.getThreadRecords(parent.threadId, ["runs", "subagents"]);
          const task = after.subagents.find((candidate) => candidate.id === worker.task.id)!;
          assert.equal(task.result, "Worker result.");
          if (owner === "thread" && closure === "stopped") {
            assert.equal(task.completionDelivery?.state, "claimed");
            assert.deepEqual(parent.cohortOf(after)?.delivery?.taskIds, [worker.task.id]);
            // A re-offer names the same message and generation, so it dispatches no second wake.
            const delivery = parent.cohortOf(after)!.delivery!;
            assert.isAbove(offer.mock.calls.length, 0);
            for (const [request] of offer.mock.calls) {
              assert.deepEqual(request.delegatedCompletion, {
                parentRunId: null,
                generation: delivery.generation,
                messageId: delivery.messageId,
              });
            }
          } else {
            assert.equal(task.completionDelivery?.state, "disposed");
            assert.isTrue(parent.cohortOf(after)?.delivery == null);
            assert.equal(offer.mock.calls.length, 0);
          }
        }).pipe(Effect.ensuring(Effect.sync(() => offer.mockRestore())));
      }),
    );
  },
);

it.layer(layerTest)("workspace preparation failure for both cohort owners", (it) => {
  it.effect.each(cohortOwners)(
    "a %s-owned worker can retry after its delivered preparation failure archives it",
    (owner) =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const parent = yield* seedOwnedParent(owner, "preparation-failed", {
          deliveryState: "delivered",
          withDelivery: false,
          parentRunEnded: true,
        });
        const worker = finishedWorkerEvents(parent, "worker", "unused");
        const childThreadId = worker.task.childThreadId;
        // The worker's thread and task exist; its run has not started.
        yield* sink.write({ events: worker.events.slice(0, 2) });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${parent.key}-worker-start`),
          threadId: childThreadId,
          senderThreadId: parent.threadId,
          messageId: MessageId.make(`message:${parent.key}-worker-start`),
          text: "Implement the issue.",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "agent",
          creationSource: "server",
        });
        const preparing = (yield* engine.getThreadProjection(childThreadId)).runs[0]!;
        assert.equal(preparing.status, "preparing");
        const { sequence } = yield* engine.dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make(`${parent.key}-worker-preparation-failed`),
          threadId: childThreadId,
          runId: preparing.id,
          failure: {
            class: "validation_error",
            message: "Worktree setup failed: branch already exists",
            code: null,
            retryable: false,
          },
        });
        yield* sink.stream({ afterSequence: sequence - 1, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === worker.task.id &&
              stored.event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const after = yield* engine.getThreadProjection(parent.threadId);
        const task = after.subagents.find((candidate) => candidate.id === worker.task.id)!;
        assert.include(task.result, "Worktree setup failed: branch already exists");
        assert.equal(task.completionDelivery?.state, "claimed");
        assert.deepEqual(parent.cohortOf(after)?.delivery?.taskIds, [worker.task.id]);
        yield* engine.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`${parent.key}-worker-preparation-observed`),
          parentThreadId: parent.threadId,
          taskId: task.id,
          observedByRunId: parent.parentRunId ?? RunId.make("observing-run"),
        });
        assert.isNotNull((yield* engine.getThreadProjection(childThreadId)).thread.archivedAt);
        yield* engine.dispatch({
          type: "prepared-run.retry",
          commandId: CommandId.make(`${parent.key}-worker-preparation-retry`),
          threadId: childThreadId,
          runId: preparing.id,
        });
        const retried = yield* engine.getThreadProjection(childThreadId);
        assert.isNull(retried.thread.archivedAt);
        assert.equal(retried.runs[0]?.status, "preparing");
      }),
  );
});

it.layer(layerTest)("child question wake", (it) => {
  it.effect("wakes the parent with the full question once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const question = yield* seedChildWaitingOnUser({
        name: "live-details",
        requestKind: "user_input",
      });
      yield* wakeChildQuestion(question);
      yield* orchestrator.recoverDelegatedTasks;
      const notices = yield* childQuestionNotices(question.parentThreadId);
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.text, "Should I also fix the lexer?");
      assert.include(notices[0]!.text, "Fix both parser and lexer");
      assert.include(notices[0]!.text, 't3_pending_request action="respond"');
      assert.include(notices[0]!.text, "waiting on you, its orchestrator");
      assert.isFalse(yield* ownerCanSee(question));
    }),
  );
  it.effect("wakes once when a routed approval's prompt arrives after its request", () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      const child = yield* seedChildWaitingOnUser({
        name: "delayed-approval",
        requestKind: "command",
      });
      const before = yield* engine.getThreadProjection(child.childThreadId);
      const requestId = RuntimeRequestId.make("request:delayed-approval");
      const now = yield* DateTime.now;
      const requestEvent = {
        id: EventId.make("event:delayed-approval-request"),
        type: "runtime-request.updated" as const,
        threadId: child.childThreadId,
        occurredAt: now,
        payload: { ...before.runtimeRequests[0]!, id: requestId },
      };
      yield* sink.write({ events: [requestEvent] });
      yield* reactor.handle(requestEvent);
      assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
      const prompt = before.turnItems.find((item) => item.type === "approval_request")!;
      if (prompt.type !== "approval_request") throw new Error("missing approval prompt");
      const promptEvent = {
        id: EventId.make("event:delayed-approval-prompt"),
        type: "turn-item.updated" as const,
        threadId: child.childThreadId,
        occurredAt: now,
        payload: { ...prompt, id: TurnItemId.make("item:delayed-approval"), requestId },
      };
      yield* sink.write({ events: [promptEvent] });
      yield* reactor.handle(promptEvent);
      yield* reactor.handle(promptEvent);
      const notices = yield* childQuestionNotices(child.parentThreadId);
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.text, "cat /tmp/requested-file");
    }),
  );
});

it.layer(layerTest)("delegated request routing", (it) => {
  it.effect(
    "shows the unchanged request after a restart with continuation off, including a started wake (D1)",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const sink = yield* EventSink.EventSinkV2;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ continueThreadsAfterServerUpdate: false });
        for (const started of [false, true]) {
          const child = yield* seedChildWaitingOnUser({
            name: `restart-${started}`,
            requestKind: "user_input",
            answeredByMessage: true,
          });
          yield* wakeChildQuestion(child);
          assert.isFalse(yield* ownerCanSee(child));
          if (started) {
            const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
            const wake = (yield* childQuestionWake(child.parentThreadId))!;
            const now = yield* DateTime.now;
            yield* sink.write({
              commandId: reconcileCommandId(`start-wake:${child.requestId}`),
              events: parent.runs.map((run) => ({
                id: EventId.make(`event:started-wake:${run.id}`),
                type: "run.updated" as const,
                threadId: child.parentThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status: run.id === wake.id ? ("running" as const) : ("completed" as const),
                  queuePosition: null,
                  startedAt: now,
                  completedAt: run.id === wake.id ? null : now,
                },
              })),
            });
          }
          const before = (yield* orchestrator.getThreadShell(child.childThreadId))!
            .pendingRuntimeRequest;
          yield* recovery.recover;
          assert.isTrue(yield* ownerCanSee(child));
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(child.childThreadId))!.pendingRuntimeRequest,
            before,
          );
          const wake = (yield* childQuestionWake(child.parentThreadId))!;
          assert.equal(wake.status, started ? "cancelled" : "queued");
          if (!started) assert.isTrue(wake.queueHeld);
        }
      }),
  );

  it.effect.each(["stop", "interrupt"] as const)(
    "shows the request when the parent is %s, including a blocking wait (D2)",
    (action) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        for (const blocking of [false, true]) {
          const child = yield* seedChildWaitingOnUser({
            name: `${action}-${blocking}`,
            requestKind: "user_input",
            completionWake: blocking ? "settled_only" : "always",
          });
          if (!blocking) yield* wakeChildQuestion(child);
          else assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
          assert.isFalse(yield* ownerCanSee(child));
          const before = (yield* orchestrator.getThreadShell(child.childThreadId))!
            .pendingRuntimeRequest;
          const parent = (yield* orchestrator.getThreadShell(child.parentThreadId))!;
          yield* orchestrator.dispatch(
            action === "stop"
              ? {
                  type: "thread.stop",
                  commandId: CommandId.make(`command:visibility-stop:${child.requestId}`),
                  threadId: child.parentThreadId,
                }
              : {
                  type: "run.interrupt",
                  commandId: CommandId.make(`command:visibility-interrupt:${child.requestId}`),
                  threadId: child.parentThreadId,
                  runId: parent.activeRunId!,
                  holdQueue: true,
                },
          );
          assert.isTrue(yield* ownerCanSee(child));
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(child.childThreadId))!.pendingRuntimeRequest,
            before,
          );
        }
      }),
  );

  it.effect.each(["completed", "failed"] as const)(
    "shows a request when its parent turn ends %s without answering",
    (status) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = yield* seedChildWaitingOnUser({
          name: `ended-${status}`,
          requestKind: "command",
        });
        yield* wakeChildQuestion(child);
        const before = (yield* orchestrator.getThreadShell(child.childThreadId))!
          .pendingRuntimeRequest;
        yield* endParentRuns(child.parentThreadId, status);
        assert.isTrue(yield* ownerCanSee(child));
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(child.childThreadId))!.pendingRuntimeRequest,
          before,
        );
      }),
  );

  it.effect(
    "keeps a queued wake hidden, and cancelling it stays hidden while the parent still runs",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = yield* seedChildWaitingOnUser({
          name: "queued-visibility",
          requestKind: "user_input",
        });
        yield* wakeChildQuestion(child);
        const wake = (yield* childQuestionWake(child.parentThreadId))!;
        assert.equal(wake.status, "queued");
        assert.isFalse(yield* ownerCanSee(child));
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("command:visibility-cancel-wake"),
          threadId: child.parentThreadId,
          runId: wake.id,
        });
        assert.isFalse(yield* ownerCanSee(child));
        yield* endParentRuns(child.parentThreadId, "interrupted");
        assert.isTrue(yield* ownerCanSee(child));
      }),
  );

  it.effect("keeps a request hidden while only its queued wake remains", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const child = yield* seedChildWaitingOnUser({
        name: "only-queued-wake",
        requestKind: "user_input",
      });
      yield* wakeChildQuestion(child);
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const original = parent.runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: reconcileCommandId("queued-only"),
        events: [
          {
            id: EventId.make("event:queued-only-parent-ended"),
            type: "run.updated",
            threadId: child.parentThreadId,
            runId: original.id,
            occurredAt: now,
            payload: { ...original, status: "completed", completedAt: now },
          },
        ],
      });
      const shell = (yield* orchestrator.getThreadShell(child.parentThreadId))!;
      assert.equal(shell.status, "queued");
      assert.isNull(shell.activeRunId);
      assert.isFalse(yield* ownerCanSee(child));
    }),
  );

  it.effect(
    "replays stored routes and historical fallback events without rerouting legacy requests",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const routed = yield* seedChildWaitingOnUser({
          name: "replay-routed",
          requestKind: "user_input",
        });
        const fallback = yield* seedChildWaitingOnUser({
          name: "replay-fallback",
          requestKind: "user_input",
          legacyUnrouted: true,
        });
        yield* endParentRuns(routed.parentThreadId, "completed");
        assert.isTrue(yield* ownerCanSee(routed));
        assert.isTrue(yield* ownerCanSee(fallback));
        yield* maintenance.pruneEventStore();
        assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
        assert.equal(
          (yield* orchestrator.getThreadShell(routed.childThreadId))?.pendingRuntimeRequest
            ?.routedTo,
          routed.parentThreadId,
        );
        assert.isUndefined(
          (yield* orchestrator.getThreadShell(fallback.childThreadId))?.pendingRuntimeRequest
            ?.routedTo,
        );
        assert.isTrue(yield* ownerCanSee(routed));
        assert.isTrue(yield* ownerCanSee(fallback));
      }),
  );

  it.effect("lets an outside agent the owner allows approve only in threads it launched", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const child = yield* seedChildWaitingOnUser({
        name: "outside-relay",
        requestKind: "command",
      });
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      // The bot launched the parent; its subagent's approval is the one waiting.
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:outside-relay-launched"),
            type: "thread.metadata-updated",
            threadId: child.parentThreadId,
            occurredAt: yield* DateTime.now,
            payload: { ...parent.thread, mcpClientSessionId: "session-bot" },
          },
        ],
      });
      const respond = (callerClientSessionId: string, name: string) =>
        threads.respondToPendingRequest({
          projectId: child.projectId,
          threadId: child.childThreadId,
          requestId: child.requestId,
          callerClientSessionId,
          commandId: CommandId.make(`command:${name}`),
          decision: "accept",
        });
      const refused = (callerClientSessionId: string, name: string) =>
        respond(callerClientSessionId, name).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      assert.equal(
        yield* refused("session-bot", "relay-not-granted"),
        "ThreadManagementPendingRequestError",
      );
      // Each Settings switch saves its own key; two saves both stick.
      yield* settings.updateSettings({ mcpApprovalRelaySessions: { "session-other": true } });
      yield* settings.updateSettings({ mcpApprovalRelaySessions: { "session-bot": true } });
      assert.equal(
        yield* refused("session-other", "relay-not-launched"),
        "ThreadManagementPendingRequestError",
      );
      // A fork of the bot's thread keeps its root but is not the bot's own work.
      const forked = (yield* orchestrator.getThreadProjection(child.childThreadId)).thread;
      const setLineage = (name: string, lineage: typeof forked.lineage) =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:outside-relay-${name}`),
              type: "thread.metadata-updated",
              threadId: child.childThreadId,
              occurredAt: forked.updatedAt,
              payload: { ...forked, lineage },
            },
          ],
        });
      yield* setLineage("fork", { ...forked.lineage, relationshipToParent: "fork" });
      assert.equal(
        yield* refused("session-bot", "relay-fork"),
        "ThreadManagementPendingRequestError",
      );
      yield* setLineage("subagent", forked.lineage);
      yield* respond("session-bot", "relay-granted");
      assert.equal(
        (yield* orchestrator.getThreadProjection(child.childThreadId)).runtimeRequests[0]?.decision,
        "accept",
      );
    }),
  );

  it.effect("keeps Writer questions visible to the owner and refuses parent answers", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const child = yield* seedChildWaitingOnUser({
        name: "writer-owner-question",
        requestKind: "user_input",
        role: "writer",
      });
      assert.isTrue(yield* ownerCanSee(child));
      yield* wakeChildQuestion(child);
      assert.lengthOf(yield* childQuestionNotices(child.parentThreadId), 0);
      const response = {
        projectId: child.projectId,
        threadId: child.childThreadId,
        requestId: child.requestId,
        commandId: CommandId.make("command:writer-parent-answer"),
        answers: { q1: "Yes" },
      };
      const error = yield* threads
        .respondToPendingRequest({
          ...response,
          callerThreadId: child.parentThreadId,
        })
        .pipe(Effect.flip);
      assert.include(error.message, "delegated descendant");
      yield* threads.respondToPendingRequest({
        ...response,
        commandId: CommandId.make("command:writer-owner-answer"),
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(child.childThreadId)).runtimeRequests[0]?.answers,
        { q1: "Yes" },
      );
    }),
  );

  it.effect("routes approvals with their full command and records parent responses", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const child = yield* seedChildWaitingOnUser({ name: "approval", requestKind: "command" });
      yield* wakeChildQuestion(child);
      const notices = yield* childQuestionNotices(child.parentThreadId);
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.text, "cat /tmp/requested-file");
      assert.include(notices[0]!.text, 'decision: "accept" or "decline"');
      const unrelated = yield* seedChildWaitingOnUser({
        name: "unrelated",
        requestKind: "user_input",
      });
      const denied = yield* threads
        .respondToPendingRequest({
          ...child,
          threadId: child.childThreadId,
          callerThreadId: unrelated.parentThreadId,
          commandId: CommandId.make("command:unrelated-approval"),
          decision: "accept",
        })
        .pipe(Effect.flip);
      assert.equal(denied._tag, "ThreadManagementPendingRequestError");
      const questionDenied = yield* threads
        .respondToPendingRequest({
          ...unrelated,
          threadId: unrelated.childThreadId,
          callerThreadId: child.parentThreadId,
          commandId: CommandId.make("command:unrelated-question"),
          answers: { q1: "Yes" },
        })
        .pipe(Effect.flip);
      assert.equal(questionDenied._tag, "ThreadManagementPendingRequestError");
      yield* threads.respondToPendingRequest({
        ...child,
        threadId: child.childThreadId,
        callerThreadId: child.parentThreadId,
        commandId: CommandId.make("command:parent-approval"),
        decision: "accept",
      });
      const answered = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.equal(answered.runtimeRequests[0]?.decision, "accept");
      assert.equal(
        answered.turnItems[0]?.type === "approval_request"
          ? answered.turnItems[0].respondedBy
          : undefined,
        "orchestrator",
      );
      const declined = yield* seedChildWaitingOnUser({ name: "decline", requestKind: "command" });
      yield* threads.respondToPendingRequest({
        ...declined,
        threadId: declined.childThreadId,
        callerThreadId: declined.parentThreadId,
        commandId: CommandId.make("command:parent-decline"),
        decision: "decline",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(declined.childThreadId)).runtimeRequests[0]
          ?.decision,
        "decline",
      );
      yield* threads.respondToPendingRequest({
        ...unrelated,
        threadId: unrelated.childThreadId,
        callerThreadId: unrelated.parentThreadId,
        commandId: CommandId.make("command:parent-question"),
        answers: { q1: "No" },
      });
      const question = yield* orchestrator.getThreadProjection(unrelated.childThreadId);
      assert.deepEqual(question.runtimeRequests[0]?.answers, { q1: "No" });
      assert.equal(
        question.turnItems[0]?.type === "user_input_request"
          ? question.turnItems[0].respondedBy
          : undefined,
        "orchestrator",
      );
      for (const answeredChild of [child, declined, unrelated]) {
        yield* endParentRuns(answeredChild.parentThreadId, "completed");
        assert.isFalse(yield* ownerCanSee(answeredChild));
      }
    }),
  );

  it.effect("returns a pending request to the owner when its parent becomes archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const child = yield* seedChildWaitingOnUser({
        name: "later-archive",
        requestKind: "user_input",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(child.childThreadId))?.pendingRuntimeRequest?.routedTo,
        child.parentThreadId,
      );
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const now = yield* DateTime.now;
      const task = parent.subagents[0]!;
      // A historical task can outlive its child; it must not prevent the fallback.
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:missing-child-task"),
            type: "subagent.updated",
            threadId: child.parentThreadId,
            nodeId: NodeId.make("node:missing-child-task"),
            occurredAt: now,
            payload: {
              ...task,
              id: NodeId.make("node:missing-child-task"),
              childThreadId: ThreadId.make("thread:missing-child"),
            },
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:later-archive"),
            type: "thread.archived",
            threadId: child.parentThreadId,
            occurredAt: now,
            payload: { ...parent.thread, archivedAt: now },
          },
        ],
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(child.childThreadId))?.pendingRuntimeRequest?.routedTo,
        child.parentThreadId,
      );
      assert.isTrue(yield* ownerCanSee(child));
    }),
  );

  it.effect(
    "routes a nested child to its direct parent and lets the root approve after that parent is archived",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const outer = yield* seedChildWaitingOnUser({
          name: "nested-outer",
          requestKind: "user_input",
        });
        const inner = yield* seedChildWaitingOnUser({
          name: "nested-inner",
          requestKind: "command",
        });
        const intermediate = yield* orchestrator.getThreadProjection(inner.parentThreadId);
        const taskId = NodeId.make("node:nested-intermediate");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:nested-intermediate"),
              type: "thread.metadata-updated",
              threadId: inner.parentThreadId,
              occurredAt: now,
              payload: {
                ...intermediate.thread,
                lineage: {
                  parentThreadId: outer.childThreadId,
                  relationshipToParent: "subagent",
                  rootThreadId: outer.parentThreadId,
                },
                forkedFrom: { type: "node", nodeId: taskId },
              },
            },
            {
              id: EventId.make("event:nested-task"),
              type: "subagent.updated",
              threadId: outer.childThreadId,
              occurredAt: now,
              payload: {
                ...intermediate.subagents[0]!,
                id: taskId,
                threadId: outer.childThreadId,
                childThreadId: inner.parentThreadId,
              },
            },
          ],
        });
        assert.equal(
          (yield* orchestrator.getThreadShell(inner.childThreadId))?.pendingRuntimeRequest
            ?.routedTo,
          inner.parentThreadId,
        );
        assert.isFalse(yield* ownerCanSee(inner));
        const linkedParent = yield* orchestrator.getThreadProjection(inner.parentThreadId);
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:nested-parent-archived"),
              type: "thread.archived",
              threadId: inner.parentThreadId,
              occurredAt: now,
              payload: { ...linkedParent.thread, archivedAt: now },
            },
          ],
        });
        assert.isTrue(yield* ownerCanSee(inner));
        assert.equal(
          (yield* orchestrator.getThreadShell(inner.childThreadId))?.pendingRuntimeRequest
            ?.routedTo,
          inner.parentThreadId,
        );
        yield* threads.respondToPendingRequest({
          ...inner,
          threadId: inner.childThreadId,
          callerThreadId: outer.parentThreadId,
          commandId: CommandId.make("command:root-answer-grandchild"),
          decision: "accept",
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(inner.childThreadId)).runtimeRequests[0]
            ?.decision,
          "accept",
        );
      }),
  );

  it.effect(
    "keeps requests owner-facing when the parent is archived, deleted, or provider-native",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        for (const config of [
          { name: "missing-parent", parentState: "missing" as const },
          { name: "archived-parent", parentState: "archived" as const },
          { name: "deleted-parent", parentState: "deleted" as const },
          { name: "native-child", origin: "provider_native" as const },
        ]) {
          const child = yield* seedChildWaitingOnUser({ ...config, requestKind: "user_input" });
          yield* orchestrator.recoverDelegatedTasks;
          assert.isUndefined(
            (yield* orchestrator.getThreadShell(child.childThreadId))?.pendingRuntimeRequest
              ?.routedTo,
          );
          assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
        }
      }),
  );
});

it.layer(
  Layer.mergeAll(layerTest, EffectOutbox.layer, ThreadCommandExecutor.layer).pipe(
    Layer.provide(SqlitePersistence.layerMemory),
  ),
)("checkpoint capture failure visibility", (it) => {
  it.effect("exhausted real checkpoint capture settles the parent and holds its queued wake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const child = yield* seedChildWaitingOnUser({
        name: "checkpoint-exhausted",
        requestKind: "user_input",
        completionWake: "settled_only",
      });
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const run = parent.runs[0]!;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:checkpoint-exhausted:wake"),
        threadId: child.parentThreadId,
        messageId: MessageId.make(
          `message:delegated-task-question:${child.parentThreadId}:${child.requestId}`,
        ),
        text: "A child is waiting for your answer.",
        notification: {
          source: { kind: "delegated_task", taskIds: [parent.subagents[0]!.id] },
          outcome: "updated",
          summary: "A child has a question.",
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      const rootNode = parent.nodes.find((node) => node.id === run.rootNodeId)!;
      const scopeId = CheckpointScopeId.make("scope:checkpoint-exhausted");
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: reconcileCommandId("checkpoint-exhausted:waiting"),
        events: [
          {
            id: EventId.make("event:checkpoint-exhausted:waiting"),
            type: "run.updated",
            threadId: child.parentThreadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "waiting", completedAt: null },
          },
          {
            id: EventId.make("event:checkpoint-exhausted:node"),
            type: "node.updated",
            threadId: child.parentThreadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...rootNode, status: "waiting", checkpointScopeId: scopeId },
          },
          {
            id: EventId.make("event:checkpoint-exhausted:scope"),
            type: "checkpoint-scope.created",
            threadId: child.parentThreadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: scopeId,
              threadId: child.parentThreadId,
              runId: run.id,
              nodeId: rootNode.id,
              parentScopeId: null,
              providerThreadId: run.providerThreadId!,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: "/repo",
              createdAt: now,
            },
          },
        ],
      });
      const effectId = "effect:checkpoint-exhausted";
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
          threadId: child.parentThreadId,
          request: { type: "checkpoint.capture", runId: run.id, scopeId },
        },
      ]);
      const captureLayer = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            materializeBaselineCheckpoint: ({ ordinalWithinScope }) =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId,
                  ordinalWithinScope,
                  cause: "injected checkpoint write failure",
                }),
              ),
          }),
        ),
      );
      const workerLayer = EffectWorker.layerWithOptions({ maxAttempts: 2 }).pipe(
        Layer.provide(
          EffectWorker.layerExecutor.pipe(
            Layer.provide(
              Layer.mergeAll(
                RunFinalizationService.layer.pipe(Layer.provide(captureLayer)),
                Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
                Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({
                  start: () => Effect.void,
                }),
                Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
                Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({
                  execute: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
        Layer.provide(IdAllocator.layer),
      );
      const afterSequence = yield* sink.latestSequence();
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
        assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).attemptCount, 1);
        assert.equal(
          (yield* orchestrator.getThreadProjection(child.parentThreadId)).runs.find(
            (row) => row.id === run.id,
          )?.status,
          "waiting",
        );
        assert.isFalse(yield* ownerCanSee(child));
        yield* TestClock.adjust("100 millis");
        yield* worker.drain();
      }).pipe(Effect.provide(Layer.fresh(workerLayer)));
      assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "failed");
      assert.equal(
        (yield* orchestrator.getThreadProjection(child.parentThreadId)).runs.find(
          (row) => row.id === run.id,
        )?.status,
        "failed",
      );
      // Queue reconciliation runs after the terminal event commits. Await its durable hold.
      yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.queueHeld === true,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const settled = yield* orchestrator.getThreadProjection(child.parentThreadId);
      assert.equal(settled.runs.find((row) => row.id === run.id)?.status, "failed");
      assert.equal(settled.nodes.find((node) => node.id === rootNode.id)?.status, "failed");
      assert.isTrue(
        settled.turnItems.some(
          (item) => item.type === "error" && item.failure.code === "checkpoint_capture_failed",
        ),
      );
      assert.isTrue(settled.runs.some((row) => row.status === "queued" && row.queueHeld === true));
      assert.isTrue(yield* ownerCanSee(child));
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("command:checkpoint-exhausted:resume"),
        threadId: child.parentThreadId,
      });
      assert.isFalse(
        (yield* orchestrator.getThreadProjection(child.parentThreadId)).runs.some(
          (row) => row.status === "queued" && row.queueHeld === true,
        ),
      );
    }),
  );
});

it.layer(layerTest)("child question wake admission", (it) => {
  it.effect("Stop during child prompt loading prevents a subsequent parent wake", () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const child = yield* seedChildWaitingOnUser({
        name: "stop-during-question",
        requestKind: "user_input",
        answeredByMessage: true,
      });
      yield* endParentRuns(child.parentThreadId, "completed");
      const promptRead = yield* Deferred.make<void>();
      const releasePrompt = yield* Deferred.make<void>();
      const getThreadRecords = projections.getThreadRecords;
      const read = vi
        .spyOn(projections, "getThreadRecords")
        .mockImplementation((threadId, fields, filter) =>
          getThreadRecords(threadId, fields, filter).pipe(
            Effect.tap(() =>
              threadId === child.childThreadId &&
              filter?.turnItemTypes?.includes("user_input_request")
                ? Deferred.succeed(promptRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePrompt)),
                  )
                : Effect.void,
            ),
          ),
        );
      yield* Effect.gen(function* () {
        const waking = yield* wakeChildQuestion(child).pipe(Effect.forkChild);
        // Hold prompt loading so Stop commits before wake admission.
        yield* Deferred.await(promptRead);
        yield* engine.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-during-question"),
          threadId: child.parentThreadId,
        });
        yield* Deferred.succeed(releasePrompt, undefined);
        yield* Fiber.join(waking);
        assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
        const parent = yield* engine.getThreadProjection(child.parentThreadId);
        assert.isFalse(
          parent.runs.some((run) => ["preparing", "starting", "running"].includes(run.status)),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(releasePrompt, undefined);
            read.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect("a held parent queue admits no fresh child wake and stays owner-visible", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const child = yield* seedChildWaitingOnUser({
        name: "already-held-question",
        requestKind: "user_input",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("held-later-work"),
        threadId: child.parentThreadId,
        messageId: MessageId.make("held-later-work"),
        text: "Later user work",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: reconcileCommandId("held-question"),
        events: parent.runs.map((run) => ({
          id: EventId.make(`held-question:${run.id}`),
          type: "run.updated",
          threadId: child.parentThreadId,
          occurredAt: now,
          payload:
            run.status === "queued"
              ? { ...run, queueHeld: true }
              : { ...run, status: "interrupted", completedAt: now },
        })),
      });
      assert.isTrue(yield* ownerCanSee(child));
      yield* wakeChildQuestion(child);
      const after = yield* orchestrator.getThreadProjection(child.parentThreadId);
      assert.isFalse(
        after.runs.some((run) => ["preparing", "starting", "running"].includes(run.status)),
      );
      assert.isTrue(yield* ownerCanSee(child));
      assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
      // Releasing the hold resumes existing queued work; no replayed child wake is needed.
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("release-held-question"),
        threadId: child.parentThreadId,
      });
      const resumed = yield* orchestrator.getThreadProjection(child.parentThreadId);
      assert.equal(resumed.runs.length, parent.runs.length);
      assert.isTrue(
        resumed.runs.some((run) => ["preparing", "starting", "running"].includes(run.status)),
      );
      assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
    }),
  );

  it.effect("a rejected child wake leaves the request owner-visible without queued intake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const child = yield* seedChildWaitingOnUser({
        name: "rejected-question",
        requestKind: "user_input",
      });
      yield* endParentRuns(child.parentThreadId, "completed");
      const parent = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const missing = ProviderInstanceId.make("missing-question-provider");
      yield* sink.write({
        commandId: reconcileCommandId("missing-question-provider"),
        events: [
          {
            id: EventId.make("missing-question-provider"),
            type: "thread.metadata-updated",
            threadId: child.parentThreadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...parent.thread,
              providerInstanceId: missing,
              modelSelection: { ...parent.thread.modelSelection, instanceId: missing },
            },
          },
        ],
      });
      yield* wakeChildQuestion(child);
      assert.isTrue(yield* ownerCanSee(child));
      assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
    }),
  );

  it.effect(
    "Stop prevents a delayed child prompt from starting a stray parent run, including a repeated no-op Stop",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const child = yield* seedChildWaitingOnUser({
          name: "stop-delayed-question",
          requestKind: "user_input",
          answeredByMessage: true,
        });
        yield* endParentRuns(child.parentThreadId, "completed");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("delayed-first-stop"),
          threadId: child.parentThreadId,
        });
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const prior = before.runtimeRequests[0]!;
        const requestId = RuntimeRequestId.make("question-with-delayed-prompt");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("delayed-question"),
              type: "runtime-request.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: { ...prior, id: requestId, createdAt: now },
            },
          ],
        });
        const stopped = yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("delayed-second-stop"),
          threadId: child.parentThreadId,
        });
        assert.equal(stopped.storedEvents.length, 0);
        const prompt = before.turnItems.find((item) => item.type === "user_input_request")!;
        if (prompt.type !== "user_input_request") throw new Error("missing prompt");
        yield* sink.write({
          events: [
            {
              id: EventId.make("delayed-prompt"),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: { ...prompt, id: TurnItemId.make("delayed-prompt"), requestId },
            },
          ],
        });
        yield* wakeChildQuestion({ ...child, requestId });
        assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
        assert.isFalse(
          (yield* orchestrator.getThreadProjection(child.parentThreadId)).runs.some((run) =>
            ["preparing", "starting", "running"].includes(run.status),
          ),
        );
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* orchestrator.getThreadShell(child.childThreadId);
        assert.isTrue(
          runtimeRequestIsOwnerVisible(
            { routedTo: child.parentThreadId },
            yield* orchestrator.getThreadShell(child.parentThreadId),
          ),
        );
        assert.isTrue(shell !== null && shell.pendingRuntimeRequest !== null);
        assert.equal(
          (yield* projections.getRuntimeRequest(child.childThreadId, requestId))?.status,
          "pending",
        );
      }),
  );

  it.effect("cancelling a stopped parent's queued message keeps the Stop in force", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const child = yield* seedChildWaitingOnUser({
        name: "cancelled-queue-after-stop",
        requestKind: "user_input",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queued-before-stop"),
        threadId: child.parentThreadId,
        messageId: MessageId.make("queued-before-stop"),
        text: "Later user work",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-with-queued-work"),
        threadId: child.parentThreadId,
      });
      const stopped = yield* orchestrator.getThreadProjection(child.parentThreadId);
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: reconcileCommandId("stop-with-queued-work-settled"),
        events: stopped.runs
          .filter((run) => run.status !== "queued")
          .map((run) => ({
            id: EventId.make(`stop-with-queued-work:${run.id}`),
            type: "run.updated",
            threadId: child.parentThreadId,
            occurredAt: now,
            payload: { ...run, status: "interrupted", completedAt: now },
          })),
      });
      const queued = stopped.runs.find((run) => run.status === "queued");
      assert.isTrue(queued !== undefined);
      if (queued === undefined) return;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel-queued-after-stop"),
        threadId: child.parentThreadId,
        runId: queued.id,
      });
      yield* wakeChildQuestion(child);
      assert.equal((yield* childQuestionNotices(child.parentThreadId)).length, 0);
      assert.isTrue(yield* ownerCanSee(child));
    }),
  );
});
