import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, NodeId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  createReviewRoot,
  delegateReviewIssue,
  makeHarness,
  modelSelection,
  projectId,
  reviewIssue,
  reviewRead,
} from "./ThreadLaunchService.testHarness.ts";

const harness = makeHarness({
  issueServiceLayer: Layer.mock(IssueService.IssueService)({
    workRead: (input) => Effect.succeed(reviewRead(reviewIssue(input.number))),
  }),
});
const dependencies = Layer.mergeAll(
  IssueWorkStore.layer,
  ProjectionStore.layer,
  IdAllocator.layer,
).pipe(Layer.provideMerge(harness.layer));
const layerTest = ProviderRuntimeRecovery.layer.pipe(Layer.provideMerge(dependencies));

it.effect(
  "after restart a completed current worker's auto follow-up waits for capacity then starts",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const rootId = yield* createReviewRoot();
      yield* delegateReviewIssue(rootId, reviewIssue(1), "restart-child");
      const childId = (yield* store.issueOwner(reviewIssue(1)))!;
      const original = (yield* threads.getThreadRecords(childId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("child-completed"),
            type: "run.updated",
            threadId: childId,
            runId: original.id,
            occurredAt: now,
            payload: { ...original, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      // Use the startup stages on persisted projections, with provider execution disabled.
      yield* recovery.recover;
      yield* orchestrator.recoverDelegatedTasks;
      for (const number of [2, 3, 4, 5])
        yield* threads.dispatch({
          type: "issue.work.start",
          threadId: rootId,
          commandId: CommandId.make(`occupy-slot:${number}`),
          issue: reviewIssue(number),
          workerModelSelection: modelSelection,
          createdBy: "agent",
          creationSource: "mcp",
        });
      const blockerId = (yield* store.issueOwner(reviewIssue(2)))!;
      assert.equal(
        (yield* threads.getThreadRecords(blockerId, ["runs"])).runs[0]!.status,
        "starting",
      );
      assert.isFalse(yield* store.canAdmit(reviewIssue(1), childId));
      const followup = yield* threads.sendToThread({
        projectId,
        threadId: childId,
        senderThreadId: rootId,
        commandId: CommandId.make("current-followup"),
        messageId: MessageId.make("current-followup"),
        text: "Continue the checks",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(followup.run.status, "queued");
      assert.isNull(followup.run.startedAt);
      const blocker = (yield* threads.getThreadRecords(blockerId, ["runs"])).runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("slot-released"),
            type: "run.updated",
            threadId: blockerId,
            runId: blocker.id,
            occurredAt: now,
            payload: { ...blocker, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* threads.dispatch({
        type: "repository.work.continue",
        threadId: rootId,
        commandId: CommandId.make("admit-followup"),
      });
      const admitted = (yield* threads.getThreadRecords(childId, ["runs"])).runs.at(-1)!;
      assert.equal(admitted.id, followup.run.id);
      assert.equal(admitted.status, "starting");
      const sql = yield* SqlClient.SqlClient;
      const starts = yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${childId} AND effect_type = 'provider-turn.start'
        AND json_extract(payload_json, '$.runId') = ${followup.run.id}`;
      assert.lengthOf(starts, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("startup settles legacy queued follow-ups on a replaced issue worker", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const rootId = yield* createReviewRoot();
    yield* delegateReviewIssue(rootId, reviewIssue(1), "former-child");
    const childId = (yield* store.issueOwner(reviewIssue(1)))!;
    const original = (yield* threads.getThreadRecords(childId, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("former-completed"),
          type: "run.updated",
          threadId: childId,
          runId: original.id,
          occurredAt: now,
          payload: { ...original, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* delegateReviewIssue(rootId, reviewIssue(1), "replacement-child");
    assert.notEqual(yield* store.issueOwner(reviewIssue(1)), childId);
    const parent = yield* threads.getThreadRecords(rootId, ["subagents"]);
    const originalTask = parent.subagents.find((task) => task.childThreadId === childId)!;
    const taskId = NodeId.make("legacy-followup-task");
    const runId = RunId.make("legacy-followup-run");
    // Persist the shape accepted before 9f54b773bc; new sends are now refused.
    yield* sink.write({
      events: [
        {
          id: EventId.make("legacy-followup-run"),
          type: "run.created",
          threadId: childId,
          runId,
          occurredAt: now,
          payload: {
            ...original,
            id: runId,
            ordinal: 2,
            delegatedTaskId: taskId,
            userMessageId: MessageId.make("legacy-followup-message"),
            status: "queued",
            startedAt: null,
            completedAt: null,
            queuePosition: 2,
            rootNodeId: null,
            activeAttemptId: null,
            checkpointId: null,
          },
        },
        {
          id: EventId.make("legacy-followup-task"),
          type: "subagent.updated",
          threadId: rootId,
          nodeId: taskId,
          occurredAt: now,
          payload: {
            ...originalTask,
            id: taskId,
            status: "running",
            result: null,
            completedAt: null,
            completionDelivery: { state: "pending", observedByRunId: null },
          },
        },
      ],
    });
    yield* recovery.recover;
    yield* orchestrator.recoverDelegatedTasks;
    const recovered = (yield* threads.getThreadRecords(childId, ["runs"])).runs.at(-1)!;
    assert.equal(recovered.status, "cancelled");
    assert.isNull(recovered.startedAt);
    const task = (yield* threads.getThreadRecords(rootId, ["subagents"])).subagents.find(
      (entry) => entry.id === taskId,
    )!;
    assert.equal(task.status, "cancelled");
    assert.isNotNull(task.result);
    yield* recovery.recover;
    assert.equal(
      (yield* threads.getThreadRecords(childId, ["runs"])).runs.at(-1)!.status,
      "cancelled",
    );
  }).pipe(Effect.provide(layerTest)),
);
