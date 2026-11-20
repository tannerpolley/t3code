import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import {
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  type NodeId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import { Scheduler } from "../scheduling/Scheduler.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as QuietDelegatesWorker from "./QuietDelegatesWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  createReviewRoot,
  delegateReviewIssue,
  modelSelection,
  reviewHarness,
  reviewIssue,
  reviewRead,
} from "./ThreadLaunchService.testHarness.ts";

const harness = () => {
  const { layer } = reviewHarness(
    ({ number }) => Effect.succeed(reviewRead(reviewIssue(number))),
    false,
    undefined,
    true,
  );
  return Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provideMerge(layer)),
    ServerSettings.layerTest({}),
  );
};

const startBuild = Effect.fn("test.startBuild")(function* () {
  const root = yield* createReviewRoot();
  const issue = reviewIssue(1);
  const worker = yield* delegateReviewIssue(root, issue, "review-worker");
  const workerId = worker.storedEvents.find((entry) => entry.event.type === "thread.created")!.event
    .threadId;
  return { root, issue, workerId };
});

const finish = Effect.fn("test.finishReviewTurn")(function* (threadId: ThreadId, report: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const active = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:review-report:${active.id}`),
        type: "message.updated",
        threadId,
        runId: active.id,
        occurredAt: now,
        payload: {
          id: MessageId.make(`message:review-report:${active.id}`),
          threadId,
          runId: active.id,
          nodeId: active.rootNodeId,
          role: "assistant",
          text: report,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "agent",
          creationSource: "provider",
        },
      },
      {
        id: EventId.make(`event:review-end:${active.id}`),
        type: "run.updated",
        threadId,
        runId: active.id,
        occurredAt: now,
        payload: { ...active, status: "completed", startedAt: now, completedAt: now },
      },
    ],
  });
});

const launchReviewer = Effect.fn("test.launchReviewer")(function* (workerId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const run = (yield* threads.getThreadRecords(workerId, ["runs"])).runs.at(-1)!;
  const reviewer = yield* threads.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("review-child"),
    parentThreadId: workerId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    role: "reviewer",
    task: "Review the issue, plan and diff.",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const reviewerId = reviewer.storedEvents.find((entry) => entry.event.type === "thread.created")!
    .event.threadId;
  return { run, reviewerId };
});

it.effect.each(["original", "follow-up"] as const)(
  "keeps the %s build task in progress through review and wakes its parent once",
  (round) => {
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const issues = yield* IssueWorkService.IssueWorkService;
      const { root, issue, workerId } = yield* startBuild();
      const rootProjection = orchestrator.getThreadProjection(root);
      const rootWakes = (taskId: NodeId) =>
        rootProjection.pipe(
          Effect.map((projection) =>
            projection.messages.filter((message) =>
              round === "original"
                ? message.notification !== undefined || message.delegatedCompletion !== undefined
                : message.delegatedCompletion?.taskIds.includes(taskId),
            ),
          ),
        );
      if (round === "follow-up") {
        const beforeInitial = yield* sink.latestSequence();
        yield* finish(workerId, "Initial build finished.");
        yield* orchestrator.recoverDelegatedTask(workerId);
        yield* sink.stream({ afterSequence: beforeInitial, eventType: "message.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.threadId === root &&
              event.type === "message.updated" &&
              event.payload.delegatedCompletion !== undefined,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("review-resume"),
          threadId: workerId,
          senderThreadId: root,
          messageId: MessageId.make("message:review-resume"),
          text: "Update the PR and review it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
      }
      const { run, reviewerId } = yield* launchReviewer(workerId);
      assert.equal((yield* threads.getThreadRecords(reviewerId, [])).thread.role, "reviewer");
      yield* finish(workerId, "Build and checks passed. Waiting on review.");
      yield* orchestrator.recoverDelegatedTask(workerId);
      const openTask = (yield* rootProjection).subagents.find(
        (task) =>
          task.childThreadId === workerId &&
          (round === "original" || task.id === run.delegatedTaskId),
      )!;
      assert.isNull(openTask.result);
      assert.lengthOf(yield* rootWakes(openTask.id), 0);
      assert.equal((yield* issues.workStatus(issue)).status, "working");
      assert.include(
        (yield* issues.childrenStatus(root, (id) => id)).working.map((child) => child.threadId),
        workerId,
      );

      const beforeReview = yield* sink.latestSequence();
      yield* finish(reviewerId, "One defect needs a fix.");
      yield* sink.stream({ afterSequence: beforeReview, eventType: "message.updated" }).pipe(
        Stream.filter(
          ({ event }) =>
            event.threadId === workerId &&
            event.type === "message.updated" &&
            event.payload.delegatedCompletion !== undefined,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const reviewing = (yield* threads.getThreadRecords(workerId, ["runs"])).runs.at(-1)!;
      if (round === "follow-up") assert.equal(reviewing.delegatedTaskId, openTask.id);
      const reviewerTask = (yield* threads.getThreadRecords(workerId, [
        "subagents",
      ])).subagents.find((task) => task.childThreadId === reviewerId)!;
      yield* threads.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("review-result-read"),
        parentThreadId: workerId,
        taskId: reviewerTask.id,
        observedByRunId: reviewing.id,
      });
      yield* orchestrator.recoverDelegatedTask(workerId);
      assert.lengthOf((yield* rootProjection).subagents, round === "original" ? 1 : 2);
      assert.lengthOf(yield* rootWakes(openTask.id), 0);
      const beforeReport = yield* sink.latestSequence();
      yield* finish(workerId, "Fixed the review finding. Checks passed. PR is merge-ready.");
      yield* sink.stream({ afterSequence: beforeReport, eventType: "message.updated" }).pipe(
        Stream.filter(
          ({ event }) =>
            event.threadId === root &&
            event.type === "message.updated" &&
            event.payload.delegatedCompletion?.taskIds.includes(openTask.id) === true,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.lengthOf(yield* rootWakes(openTask.id), 1);
      assert.include(
        (yield* rootProjection).subagents.find((task) => task.id === openTask.id)?.result ?? "",
        "PR is merge-ready",
      );
    }).pipe(Effect.provide(harness()));
  },
);

it.effect("wakes each direct parent for a question before its child finishes", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const { root, workerId } = yield* startBuild();
    yield* finish(root, "Implementor assigned.");
    const { reviewerId } = yield* launchReviewer(workerId);
    yield* finish(workerId, "Build and checks passed. Waiting on review.");

    for (const [childId, parentId] of [
      [reviewerId, workerId],
      [workerId, root],
    ] as const) {
      const run = (yield* threads.getThreadRecords(childId, ["runs"])).runs.at(-1)!;
      const requestId = RuntimeRequestId.make("question:" + childId);
      const now = yield* DateTime.now;
      const question = {
        id: EventId.make("event:" + requestId),
        type: "runtime-request.updated",
        threadId: childId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          routedTo: parentId,
          createdAt: now,
          resolvedAt: null,
        },
      } as const;
      yield* sink.write({ events: [question] });
      yield* reactor.handle(question);
      const parent = yield* threads.getThreadRecords(parentId, ["runs", "messages"]);
      const wake = parent.messages.find(
        (message) =>
          message.id ===
          MessageId.make("message:delegated-task-question:" + parentId + ":" + requestId),
      );
      assert.isDefined(wake);
      assert.equal(parent.runs.find((entry) => entry.id === wake?.runId)?.status, "starting");
    }

    const outer = yield* threads.getThreadRecords(root, ["messages", "subagents"]);
    assert.isNull(outer.subagents[0]?.result);
    assert.equal(
      outer.messages.filter((message) => message.notification?.source.kind === "delegated_task")
        .length,
      1,
    );
    assert.isFalse(outer.messages.some((message) => message.delegatedCompletion !== undefined));
  }).pipe(Effect.provide(DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(harness())))),
);

it.effect("wakes the implementor once when its live reviewer goes quiet", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.UTC(2026, 10, 20));
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const { root, workerId } = yield* startBuild();
    const { reviewerId } = yield* launchReviewer(workerId);
    const reviewer = (yield* threads.getThreadRecords(reviewerId, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:reviewer-live"),
          type: "run.updated",
          threadId: reviewerId,
          runId: reviewer.id,
          occurredAt: now,
          payload: { ...reviewer, status: "running", startedAt: now },
        },
      ],
    });
    yield* finish(workerId, "Build and checks passed. Waiting on review.");

    let sweep = Effect.void;
    yield* Layer.build(
      QuietDelegatesWorker.workerLive.pipe(
        Layer.provide(
          Layer.merge(
            NodeCrypto.layer,
            Layer.mock(Scheduler)({
              register: (_name, work) =>
                Effect.context<Effect.Services<typeof work>>().pipe(
                  Effect.tap((context) =>
                    Effect.sync(() => {
                      sweep = work.pipe(Effect.provideContext(context), Effect.orDie);
                    }),
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
      ),
    );
    yield* TestClock.adjust("11 minutes");
    yield* sweep;
    yield* sweep;

    const worker = yield* threads.getThreadRecords(workerId, ["messages", "runs"]);
    const alerts = worker.messages.filter(
      (message) =>
        message.notification?.source.kind === "background_task" &&
        message.notification.source.quietDelegate?.threadId === reviewerId,
    );
    assert.lengthOf(alerts, 1);
    assert.equal(worker.runs.find((run) => run.id === alerts[0]?.runId)?.status, "starting");
    const parent = yield* threads.getThreadRecords(root, ["messages", "subagents"]);
    assert.isNull(parent.subagents[0]?.result);
    assert.isFalse(
      parent.messages.some(
        (message) =>
          message.notification !== undefined || message.delegatedCompletion !== undefined,
      ),
    );
  }).pipe(Effect.provide(harness())),
);
