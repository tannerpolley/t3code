import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, type NodeId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as EventSink from "./EventSink.ts";
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

it.effect(
  "keeps an issue worker in progress through review and reports only its final result",
  () => {
    const harness = reviewHarness(
      ({ number }) => Effect.succeed(reviewRead(reviewIssue(number))),
      false,
      undefined,
      true,
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const issues = yield* IssueWorkService.IssueWorkService;
      const root = yield* createReviewRoot();
      const issue = reviewIssue(1);
      const worker = yield* delegateReviewIssue(root, issue, "review-worker");
      const workerId = worker.storedEvents.find((entry) => entry.event.type === "thread.created")!
        .event.threadId;
      const finish = (threadId: ThreadId, report: string) =>
        Effect.gen(function* () {
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
      const rootProjection = orchestrator.getThreadProjection(root);
      const rootWakes = (taskId: NodeId) =>
        rootProjection.pipe(
          Effect.map((projection) =>
            projection.messages.filter((message) =>
              message.delegatedCompletion?.taskIds.includes(taskId),
            ),
          ),
        );
      const beforeInitial = yield* sink.latestSequence();
      yield* finish(workerId, "Initial build finished.");
      yield* orchestrator.recoverDelegatedTask(workerId);
      assert.include((yield* rootProjection).subagents[0]?.result ?? "", "Initial build finished");
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
      const reviewerId = reviewer.storedEvents.find(
        (entry) => entry.event.type === "thread.created",
      )!.event.threadId;

      yield* finish(workerId, "Build and checks passed. Waiting on review.");
      yield* orchestrator.recoverDelegatedTask(workerId);
      const openTask = (yield* rootProjection).subagents.find(
        (task) => task.id === run.delegatedTaskId,
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
      assert.equal(reviewing.delegatedTaskId, openTask.id);
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
      assert.lengthOf((yield* rootProjection).subagents, 2);
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
    }).pipe(Effect.provide(harness.layer));
  },
);
