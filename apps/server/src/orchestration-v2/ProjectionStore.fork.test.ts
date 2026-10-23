import { CommandId } from "@t3tools/contracts";
import { ProviderSessionId } from "@t3tools/contracts";
import { ProviderTurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";

import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const connections: Array<unknown> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") {
          statements.push(query);
          connections.push(span.attributes.get("db.connection"));
        }
      };
      return span;
    },
  });
  return { statements, tracer, connections };
};

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s shells use the latest subagent owner for duplicate provider-thread ids",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("duplicate-provider-thread-owner");
      const initial = yield* store.getThreadProjection(threadId);
      const at = initial.updatedAt;
      const otherThreadId = yield* addRolledBackRecoveryCandidate(
        "duplicate-provider-thread-owner:other",
      );
      const other = yield* store.getThreadProjection(otherThreadId);
      const otherRun = other.runs[0]!;
      const otherInstanceId = ProviderInstanceId.make("codex-other");
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-completed"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "completed", completedAt: at },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-switched"),
        type: "thread.provider-switched",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...other.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      const providerThreadId = ProviderThreadId.make("provider-thread:duplicate-owner");
      const nativeTaskId = "native-task:duplicate-provider-thread-owner";
      // The latest upsert moves the row off the later-created thread.
      for (const [appThreadId, owner] of [
        [otherThreadId, otherInstanceId],
        [threadId, providerInstanceId],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:duplicate-provider-thread-owner:${owner}`),
          type: "provider-thread.updated",
          threadId: appThreadId,
          occurredAt: at,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: owner,
            providerSessionId: null,
            appThreadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
            pendingBackgroundTasks:
              owner === otherInstanceId
                ? [{ taskId: nativeTaskId, kind: "subagent", description: "Review" }]
                : [],
          },
        });
      }
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:completed"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
      });
      const item = {
        ...initial.turnItems[0]!,
        id: TurnItemId.make("item:duplicate-provider-thread-owner"),
        providerThreadId,
        nativeItemRef: { driver, nativeId: nativeTaskId, strength: "strong" as const },
        type: "subagent" as const,
        status: "running" as const,
        subagentId: NodeId.make("node:duplicate-provider-thread-owner"),
        origin: "provider_native" as const,
        driver,
        providerInstanceId,
        childThreadId: null,
        title: "Review",
        prompt: "Review",
        result: null,
      };
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-item"),
        type: "turn-item.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...item,
          id: TurnItemId.make("item:duplicate-provider-thread-owner:other"),
          threadId: otherThreadId,
          runId: otherRun.id,
          nodeId: otherRun.rootNodeId,
          subagentId: NodeId.make("node:duplicate-provider-thread-owner:other"),
        },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:switched"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: at,
        payload: {
          ...initial.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      // The other thread's item reads its owner from a provider thread stored on another thread.
      assert.deepEqual((yield* store.getThreadProjection(otherThreadId)).providerThreads, []);
      const assertOwners = Effect.fnUntraced(function* (
        targetThreadId: ThreadId,
        expected: ReadonlyArray<unknown>,
      ) {
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === targetThreadId,
        );
        for (const shell of [yield* store.getThreadShell(targetThreadId), listed]) {
          assert.equal(shell?.providerInstanceId, otherInstanceId);
          assert.equal(shell?.activeRunId, null);
          assert.deepEqual(
            shell?.pendingBackgroundTasks?.filter((task) => task.kind === "subagent"),
            expected,
          );
        }
      });
      const owned = [
        {
          taskId: nativeTaskId,
          description: item.title,
          startedAt: item.startedAt,
          kind: "subagent",
          providerInstanceId,
        },
      ];
      yield* assertOwners(threadId, owned);
      yield* assertOwners(otherThreadId, owned);
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:stopped"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: { ...item, status: "cancelled", completedAt: at },
      });
      yield* assertOwners(threadId, []);
      const ownerSnapshot = (yield* store.getThreadProjection(threadId)).providerThreads[0]!;
      // Rollback writes its provider snapshot before the rolled-back run events.
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:rollback-provider-thread"),
        type: "provider-thread.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: ownerSnapshot,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-rolled-back"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "rolled_back", completedAt: at },
      });
      const rolledBack = yield* store.getThreadProjection(otherThreadId);
      assert.deepEqual(rolledBack.providerThreads, []);
      assert.equal(
        (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
        providerThreadId,
      );
      assert.deepEqual(
        ProjectionStore.threadShellFromProjection(rolledBack).pendingBackgroundTasks,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("finds only pending routed requests without loading historical children", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const parentId = yield* addRolledBackRecoveryCandidate("routed-request-parent");
      const parent = yield* store.getThread(parentId);
      const parentRunId = (yield* store.getThreadRecords(parentId, ["runs"])).runs[0]!.id;
      const now = yield* DateTime.now;
      const childIds: ThreadId[] = [];
      for (let index = 0; index < 20; index++) {
        const childId = ThreadId.make(`routed-request-child:${index}`);
        childIds.push(childId);
        yield* store.apply({
          id: EventId.make(`routed-child:${index}`),
          type: "thread.created",
          threadId: childId,
          occurredAt: now,
          payload: {
            ...parent,
            id: childId,
            lineage: {
              rootThreadId: parentId,
              parentThreadId: parentId,
              relationshipToParent: "subagent",
            },
          },
        });
        yield* store.apply({
          id: EventId.make(`historical-task:${index}`),
          type: "subagent.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: NodeId.make(`historical-task:${index}`),
            threadId: parentId,
            runId: parentRunId,
            parentNodeId: NodeId.make("root"),
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: childId,
            nativeTaskRef: null,
            prompt: "Inspect",
            title: null,
            model: null,
            status: "completed",
            result: "Done",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      const { statements, tracer } = traceSqlStatements();
      assert.deepEqual(
        yield* store.getPendingRoutedRequestThreadIds(parentId).pipe(Effect.withTracer(tracer)),
        [],
      );
      assert.equal(statements.length, 1);
      assert.notInclude(statements[0]!, "projection_subagents");
      const plans = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT DISTINCT thread_id FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'pending' AND json_extract(payload_json, '$.routedTo') = ${parentId}
      `;
      assert.ok(
        plans.some((plan) =>
          plan.detail.includes(
            "USING INDEX orchestration_v2_projection_runtime_requests_pending_routed_idx",
          ),
        ),
      );

      const request = {
        nodeId: NodeId.make("question"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        responseCapability: { type: "message" as const },
        createdAt: now,
        resolvedAt: null,
      };
      for (const [ordinal, [index, status, routedTo]] of (
        [
          [0, "pending", parentId],
          [0, "pending", parentId],
          [1, "resolved", parentId],
          [2, "pending", ThreadId.make("other-parent")],
          [3, "pending", undefined],
        ] as const
      ).entries()) {
        const id = RuntimeRequestId.make(`question:${ordinal}`);
        yield* store.apply({
          id: EventId.make(id),
          type: "runtime-request.updated",
          threadId: childIds[index]!,
          occurredAt: now,
          payload: { ...request, id, status, ...(routedTo === undefined ? {} : { routedTo }) },
        });
      }
      assert.deepEqual(yield* store.getPendingRoutedRequestThreadIds(parentId), [childIds[0]!]);
    }),
  );
  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
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
        },
      });

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          tokenUsage: initialUsage,
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            inputTokens: 11_000,
            outputTokens: 1_000,
            hasSubagents: false,
          },
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
      assert.deepEqual(replaced.providerTurns[0]?.turnTokenUsage, {
        usageScope: "main_agent",
        usageStatus: "partial",
        inputTokens: 11_000,
        outputTokens: 1_000,
        hasSubagents: false,
      });
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            providerInstanceId: sqlShell.providerInstanceId,
            autoProviderSwitch: sqlShell.autoProviderSwitch,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );
});

// Provider-native subagents never get runs on their child thread, so the child's shell reads the
// subagent record its parent owns, in the SQL list, SQL single-thread and memory shell paths.
const assertNativeSubagentChildShell = Effect.fn("assertNativeSubagentChildShell")(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const startedAt = yield* DateTime.now;
  const completedAt = DateTime.add(startedAt, { seconds: 5 });
  const parentId = ThreadId.make("thread:native-parent");
  const childId = ThreadId.make("thread:provider:claudeAgent:native-thread:child");
  const subagentId = NodeId.make("node:native-subagent");
  const thread = (id: ThreadId, lineage: { parentThreadId: ThreadId | null }) => ({
    createdBy: "agent" as const,
    creationSource: "provider" as const,
    id,
    projectId: ProjectId.make("project:native-subagent"),
    title: "Native subagent",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: lineage.parentThreadId,
      relationshipToParent: lineage.parentThreadId === null ? null : ("subagent" as const),
      rootThreadId: parentId,
    },
    forkedFrom:
      lineage.parentThreadId === null ? null : { type: "node" as const, nodeId: subagentId },
    createdAt: startedAt,
    updatedAt: startedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  for (const [id, parentThreadId] of [
    [parentId, null],
    [childId, parentId],
  ] as const) {
    yield* store.apply({
      id: EventId.make(`event:native-subagent:${id}`),
      type: "thread.created",
      threadId: id,
      occurredAt: startedAt,
      payload: thread(id, { parentThreadId }),
    });
  }
  const updateSubagent = (status: "running" | "completed") =>
    store.apply({
      id: EventId.make(`event:native-subagent:${status}`),
      type: "subagent.updated",
      threadId: parentId,
      nodeId: subagentId,
      driver,
      providerInstanceId,
      occurredAt: status === "running" ? startedAt : completedAt,
      payload: {
        id: subagentId,
        threadId: parentId,
        runId: null,
        parentNodeId: NodeId.make("node:native-parent-root"),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Review the diff",
        title: "Review the diff",
        model: null,
        status,
        result: null,
        startedAt,
        completedAt: status === "running" ? null : completedAt,
        updatedAt: status === "running" ? startedAt : completedAt,
      },
    });
  const epochMillis = (value: DateTime.Utc | null | undefined) =>
    value == null ? null : DateTime.toEpochMillis(value);
  const childShells = Effect.gen(function* () {
    const snapshot = yield* store.getShellSnapshot();
    return [
      yield* store.getThreadShell(childId),
      snapshot.threads.find((shell) => shell.id === childId),
    ];
  });

  yield* updateSubagent("running");
  for (const shell of yield* childShells) {
    assert.equal(shell?.status, "running");
    assert.equal(shell?.activityRunStatus, "running");
    assert.equal(epochMillis(shell?.activityRunStartedAt), DateTime.toEpochMillis(startedAt));
    assert.isNull(shell?.latestRunId);
  }
  assert.equal((yield* store.getSettlementCandidates(childId))[0]?.activityRunStatus, "running");
  assert.equal((yield* store.getThreadShell(parentId))?.status, "idle");

  yield* updateSubagent("completed");
  for (const shell of yield* childShells) {
    assert.equal(shell?.status, "completed");
    assert.isNull(shell?.activityRunStatus);
    assert.equal(epochMillis(shell?.latestRunCompletedAt), DateTime.toEpochMillis(completedAt));
  }
});

it.effect("native subagent child shells report the subagent status (SQL)", () =>
  assertNativeSubagentChildShell().pipe(Effect.provide(layerTest)),
);

it.effect("native subagent child shells report the subagent status (memory)", () =>
  assertNativeSubagentChildShell().pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("runtime discovery preserves queued-run rules while searching the recovery index", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const expected: ThreadId[] = [];
    for (const [suffix, status, payload, visible, recover] of [
      ["unheld", "queued", "{}", true, true],
      ["held", "queued", '{"queueHeld":true}', true, false],
      ["numeric-held", "queued", '{"queueHeld":1}', true, false],
      ["false", "queued", '{"queueHeld":false}', true, true],
      ["null", "queued", '{"queueHeld":null}', true, true],
      ["string", "queued", '{"queueHeld":"1"}', true, true],
      ["invalid", "queued", "invalid", true, true],
      ["preparing", "preparing", '{"queueHeld":true}', true, true],
      ["starting", "starting", "{}", true, true],
      ["running", "running", "{}", true, true],
      ["waiting", "waiting", "{}", true, true],
      ["ended", "completed", "{}", true, false],
      ["deleted", "queued", "{}", false, false],
      ["archived", "queued", "{}", true, true],
    ] as const) {
      const id = yield* addRolledBackRecoveryCandidate(`queue-${suffix}`);
      // Isolate run discovery from unfinished-item recovery.
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${id}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status}, payload_json = ${payload} WHERE thread_id = ${id}`;
      if (!visible)
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-20' WHERE thread_id = ${id}`;
      if (suffix === "archived")
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-10-20' WHERE thread_id = ${id}`;
      if (recover) expected.push(id);
    }
    const { statements, tracer } = traceSqlStatements();
    const actual = yield* store.getRecoveryThreadIds("runtime").pipe(Effect.withTracer(tracer));
    assert.sameMembers([...actual], expected);
    const query = statements.find((statement) =>
      statement.includes("WITH pending_provider_threads"),
    )!;
    const legacy = query
      .replace(
        "status IN ('queued', 'preparing', 'starting', 'running', 'waiting')\n                  AND status IN",
        "status IN",
      )
      .replace(
        "status IN ('queued', 'preparing', 'starting', 'running', 'waiting')\n                  AND status = 'queued'",
        "status = 'queued'",
      );
    assert.notEqual(query, legacy);
    const previous = yield* sql.unsafe<{ thread_id: string }>(legacy);
    assert.deepEqual(
      actual,
      previous.map((row) => ThreadId.make(row.thread_id)),
    );
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
    assert.equal(
      plan.filter(
        (row) =>
          row.detail.includes("SEARCH orchestration_v2_projection_runs USING") &&
          row.detail.includes("recovery_idx"),
      ).length,
      2,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subagent discovery retains usage-limit failures behind held continuations", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const child = yield* addRolledBackRecoveryCandidate("limit-discovery");
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${child}`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
      '$.lineage.relationshipToParent', 'subagent', '$.lineage.parentThreadId', 'parent', '$.forkedFrom', json('{"type":"node"}'))
      WHERE thread_id = ${child}`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'queued', payload_json = '{"queueHeld":true}' WHERE thread_id = ${child}`;
    assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), []);
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('limit-discovery', ${child}, 1, 'error', 'completed', '2026-10-20', '{"failure":{"class":"usage_limit"}}')`;
    const { statements, tracer } = traceSqlStatements();
    assert.deepEqual(
      yield* store.getRecoveryThreadIds("subagent-results").pipe(Effect.withTracer(tracer)),
      [child],
    );
    const query = statements.find((statement) => statement.includes("SELECT child.thread_id"))!;
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
    assert.ok(
      plan.some((row) =>
        row.detail.includes(
          "SEARCH error USING INDEX orchestration_v2_projection_turn_items_usage_limit_idx",
        ),
      ),
    );
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{"failure":{"class":"unknown"}}' WHERE turn_item_id = 'limit-discovery'`;
    assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s thread count matches visible shells, including archived threads", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal(yield* store.countThreads, 0);
    const active = yield* addRolledBackRecoveryCandidate("count-active");
    const archived = yield* addRolledBackRecoveryCandidate("count-archived");
    const deleted = yield* addRolledBackRecoveryCandidate("count-deleted");
    const now = yield* DateTime.now;
    for (const [id, type, change] of [
      [archived, "thread.archived", { archivedAt: now }],
      [deleted, "thread.deleted", { deletedAt: now }],
    ] as const) {
      const thread = yield* store.getThread(id);
      yield* store.apply({
        id: EventId.make(`count:${id}`),
        type,
        threadId: id,
        occurredAt: now,
        payload: { ...thread, ...change },
      });
    }
    const shells = yield* store.getShellSnapshot();
    assert.deepEqual(
      shells.threads.map((t) => t.id),
      [active],
    );
    assert.deepEqual(
      shells.archivedThreads.map((t) => t.id),
      [archived],
    );
    assert.equal(yield* store.countThreads, shells.threads.length + shells.archivedThreads.length);
    const selected = yield* store.getShellSnapshot({ threadIds: [archived] });
    assert.deepEqual(selected.threads, []);
    assert.deepEqual(selected.archivedThreads, shells.archivedThreads);
    const activeOnly = yield* store.getShellSnapshot({ threadIds: [active] });
    assert.deepEqual(activeOnly.threads, shells.threads);
    assert.deepEqual(activeOnly.archivedThreads, []);
    const empty = yield* store.getShellSnapshot({ threadIds: [] });
    assert.deepEqual(empty.threads, []);
    assert.deepEqual(empty.archivedThreads, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("recovery discovery uses the reader and sees each preceding commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-startup-queries-" });
    const persistence = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
    yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const child = yield* addRolledBackRecoveryCandidate("reader-discovery");
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${child}`;
      yield* sql.withTransaction(
        sql`UPDATE orchestration_v2_projection_runs SET status = 'running' WHERE thread_id = ${child}`,
      );
      const first = traceSqlStatements();
      assert.deepEqual(
        yield* store.getRecoveryThreadIds("runtime").pipe(Effect.withTracer(first.tracer)),
        [child],
      );
      assert.deepEqual(first.connections, ["reader"]);
      // Runtime recovery commits terminal runs before delegated discovery starts.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${child}`;
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
          '$.lineage.relationshipToParent', 'subagent', '$.lineage.parentThreadId', 'parent', '$.forkedFrom', json('{"type":"node"}'))
          WHERE thread_id = ${child}`;
          assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), [child]);
        }),
      );
      const after = traceSqlStatements();
      yield* Effect.gen(function* () {
        assert.deepEqual(yield* store.getRecoveryThreadIds("runtime"), []);
        assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), [child]);
        assert.deepEqual(yield* store.getRecoveryThreadIds("delegated-completions"), []);
        assert.equal(yield* store.countThreads, 1);
      }).pipe(Effect.withTracer(after.tracer));
      assert.deepEqual(after.connections, ["reader", "reader", "reader", "reader"]);
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(persistence))));
  }).pipe(
    Effect.scoped,
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.provide(NodeServices.layer),
  ),
);
