import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const layer = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const threadCreated = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2DomainEvent => {
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:ended-run-items"),
    title: threadId,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  };
};

const runEvent = (
  type: "run.created" | "run.updated",
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  return {
    id: EventId.make(`event:${runId}:${type}:${status}`),
    type,
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
};

/** The items a turn has open mid-call: two that can outlive it and two that cannot. */
const openItems = (threadId: ThreadId, ordinal: number, now: DateTime.Utc) => {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  const base = (name: string, itemOrdinal: number) => ({
    id: TurnItemId.make(`item:${runId}:${name}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinal * 100 + itemOrdinal,
    status: "running" as const,
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  });
  return [
    {
      ...base("tool", 1),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_worktree_return_to_root",
      input: null,
      output: null,
    },
    { ...base("command", 2), type: "command_execution", input: "sleep 60" },
    {
      ...base("plan", 3),
      type: "todo_list",
      planId: PlanId.make(`plan:${runId}`),
      steps: [{ id: "step-1", text: "Fix it", status: "running" }],
    },
    { ...base("reasoning", 4), type: "reasoning", text: "Thinking", streaming: true },
  ] satisfies ReadonlyArray<OrchestrationV2TurnItem>;
};

const itemEvents = (items: ReadonlyArray<OrchestrationV2TurnItem>, now: DateTime.Utc) =>
  items.map((payload): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${payload.id}`),
    type: "turn-item.updated",
    threadId: payload.threadId,
    ...(payload.runId === null ? {} : { runId: payload.runId }),
    occurredAt: now,
    payload,
  }));

const itemStates = Effect.fn(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"]);
  return Object.fromEntries(
    turnItems.map((item) => [
      `${item.runId?.split(":").at(-1)}:${item.type}`,
      "streaming" in item && item.streaming ? `${item.status}+streaming` : item.status,
    ]),
  );
});

it.effect.each([
  ["completed", "completed"],
  ["failed", "interrupted"],
  ["interrupted", "interrupted"],
  ["cancelled", "interrupted"],
] as const)(
  "a run that ends %s ends its turn-bound items %s in the same write",
  ([ended, itemStatus]) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:ended-run-items:${ended}`);
      yield* sink.write({
        events: [
          threadCreated(threadId, now),
          runEvent("run.created", threadId, 1, "running", now),
          ...itemEvents(openItems(threadId, 1, now), now),
        ],
      });

      const stored = yield* sink.write({
        events: [runEvent("run.updated", threadId, 1, ended, now)],
      });

      assert.equal(stored.length, 3);
      // Commands and dynamic tools can outlive the turn as background work.
      assert.deepStrictEqual(yield* itemStates(threadId), {
        "1:dynamic_tool": "running",
        "1:command_execution": "running",
        "1:todo_list": itemStatus,
        "1:reasoning": itemStatus,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("startup recovery ends the turn-bound items an ended run left running, once", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:ended-run-items:startup");
    // Rows an older build left: written straight to the projection.
    const turnBound = (ordinal: number) =>
      openItems(threadId, ordinal, now).filter(
        (item) => item.type === "todo_list" || item.type === "reasoning",
      );
    yield* Effect.forEach(
      [
        threadCreated(threadId, now),
        runEvent("run.created", threadId, 1, "completed", now),
        runEvent("run.created", threadId, 2, "failed", now),
        ...itemEvents([...turnBound(1), ...turnBound(2)], now),
      ],
      projections.apply,
    );
    assert.deepStrictEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

    yield* recovery.reconcile("startup");

    assert.deepStrictEqual(yield* itemStates(threadId), {
      "1:todo_list": "completed",
      "1:reasoning": "completed",
      "2:todo_list": "interrupted",
      "2:reasoning": "interrupted",
    });
    assert.deepStrictEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    const sequence = yield* sink.latestSequence({ threadId });
    yield* recovery.reconcile("startup");
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
  }).pipe(Effect.provide(layer)),
);
