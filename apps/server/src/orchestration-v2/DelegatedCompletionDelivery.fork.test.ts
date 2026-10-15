import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import { runtimeRequestIsOwnerVisible } from "@t3tools/shared/delegatedRequestVisibility";
import { assert, it } from "@effect/vitest";
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
import { vi } from "vitest";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
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

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "thread-owned completion recovery",
  (it) => {
    it.effect(
      "restart recovery re-offers and settles a thread-owned parentRunId-null delivery",
      () =>
        Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make("thread:thread-owned-recovery");
          const runId = RunId.make("run:thread-owned-recovery");
          const taskId = NodeId.make("task:thread-owned-recovery");
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make("project:thread-owned-recovery"),
            runId,
            rootNodeId: NodeId.make("root:thread-owned-recovery"),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          const parent = yield* engine.getThreadProjection(threadId);
          const run = parent.runs[0]!;
          const task = parent.subagents[0]!;
          // The result and reservation committed, but no continuation was dispatched before shutdown.
          yield* sink.write({
            commandId: reconcileCommandId("thread-owned-reservation"),
            events: [
              {
                id: EventId.make("thread-owned-cohort"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...parent.thread, delegatedCompletion: run.delegatedCompletion },
              },
              {
                id: EventId.make("thread-owned-idle-parent"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...run,
                  status: "completed",
                  completedAt: now,
                  delegatedCompletion: { ...run.delegatedCompletion!, delivery: null },
                },
              },
              {
                id: EventId.make("thread-owned-task"),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: { ...task, runId: null },
              },
            ],
          });
          const offer = vi.spyOn(requests, "offer");
          yield* Effect.gen(function* () {
            yield* engine.recoverDelegatedTasks;
            assert.equal(offer.mock.calls.length, 1);
            assert.deepEqual(offer.mock.calls[0]![0].delegatedCompletion, {
              parentRunId: null,
              generation: 1,
              messageId,
            });
            yield* engine.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("thread-owned-delivery"),
              threadId,
              messageId,
              text: "Issue worker finished.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: { parentRunId: null, generation: 1 },
              createdBy: "agent",
              creationSource: "server",
            });
            const dispatched = yield* engine.getThreadProjection(threadId);
            const deliveryRun = dispatched.runs.find(
              (candidate) => candidate.userMessageId === messageId,
            )!;
            // This delivery also ended before startup's terminal-run listener was attached.
            yield* sink.write({
              commandId: reconcileCommandId("thread-owned-delivery-ended"),
              events: [
                {
                  id: EventId.make("thread-owned-delivery-ended"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...deliveryRun, status: "completed", completedAt: now },
                },
              ],
            });
            yield* engine.recoverDelegatedTasks;
            const settled = yield* engine.getThreadProjection(threadId);
            assert.isNull(settled.thread.delegatedCompletion?.delivery);
            assert.equal(settled.subagents[0]!.completionDelivery?.state, "delivered");
            assert.equal(settled.subagents[0]!.result, "child finished");
            assert.equal(offer.mock.calls.length, 1);
          }).pipe(Effect.ensuring(Effect.sync(() => offer.mockRestore())));
        }),
    );
  },
);

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
      assert.include(notices[0]!.text, "t3_pending_request_respond");
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
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
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
  Layer.mergeAll(layerTest, EffectOutbox.layer).pipe(Layer.provide(SqlitePersistence.layerMemory)),
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
        messageId: MessageId.make("message:checkpoint-exhausted:wake"),
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
