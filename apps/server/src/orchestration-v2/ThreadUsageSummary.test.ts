import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  RunId,
  RunAttemptId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import ThreadUsageMigration from "../persistence/ForkMigrations/011_ThreadUsageSummary.ts";
import {
  DeferThreadUsageSummary,
  refreshAllThreadUsageSummaries,
  deriveThreadUsageSummary,
  backfillThreadUsageCosts,
  refreshThreadUsageSummary,
  ThreadUsagePricer,
} from "./ThreadUsageSummary.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { UsageService, type TokenPricer } from "../usage/UsageService.ts";

const now = DateTime.makeUnsafe("2026-10-13T12:00:00.000Z");
const threadId = ThreadId.make("usage-summary-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("usage-project"),
  title: "Usage",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.1" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const provider: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("usage-provider"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make(
    `provider-turn:codex:${"abcdef01-2345-6789-abcd-ef0123456789:".repeat(6)}`,
  ),
  providerThreadId: provider.id,
  nodeId: NodeId.make("usage-node"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: now,
  completedAt: null,
  tokenUsage: { usedTokens: 10_000, maxTokens: 200_000, updatedAt: DateTime.formatIso(now) },
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "partial",
    inputTokens: 40_000,
    cachedInputTokens: 30_000,
    outputTokens: 8_000,
    hasSubagents: true,
  },
};

describe("thread usage summary", () => {
  it("keeps whole-turn tokens separate from context and counts cached input once", () => {
    assert.deepEqual(deriveThreadUsageSummary(turn, provider, 148_000), {
      turnId: turn.id,
      completed: false,
      partial: true,
      latestTurnTokens: 48_000,
      inputTokens: 40_000,
      cachedInputTokens: 30_000,
      outputTokens: 8_000,
      threadTokens: 148_000,
      contextTokens: 10_000,
      contextWindow: 200_000,
    });
    assert.isUndefined(
      deriveThreadUsageSummary(
        turn,
        { ...provider, driver: ProviderDriverKind.make("cursor") },
        148_000,
      ),
    );
    const unavailable = deriveThreadUsageSummary(
      {
        ...turn,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "unavailable",
          hasSubagents: false,
        },
      },
      provider,
      undefined,
    );
    assert.isUndefined(unavailable?.latestTurnTokens);
    assert.equal(unavailable?.contextTokens, 10_000);
    assert.isUndefined(
      deriveThreadUsageSummary(
        { ...turn, tokenUsage: undefined, turnTokenUsage: undefined },
        provider,
        undefined,
      ),
    );
  });
});

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
it.layer(layer)("persisted sidebar usage", (it) => {
  it.effect(
    "agrees across SQL/memory shell reads, survives reload and backfill, and excludes nested agents",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* store.apply({
          id: EventId.make("usage-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        });
        yield* store.apply({
          id: EventId.make("usage-provider"),
          type: "provider-thread.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: provider,
        });
        yield* store.apply({
          id: EventId.make("usage-live"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: turn,
        });
        const completed = {
          ...turn,
          status: "completed" as const,
          completedAt: now,
          tokenUsage: undefined,
          turnTokenUsage: {
            ...turn.turnTokenUsage!,
            usageStatus: "complete" as const,
            inputTokens: 50_000,
            outputTokens: 10_000,
          },
        };
        yield* store.apply({
          id: EventId.make("usage-completed"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: completed,
        });
        const nested = {
          ...provider,
          id: ProviderThreadId.make("nested-provider"),
          appThreadId: null,
          ownerNodeId: NodeId.make("nested-node"),
        };
        yield* store.apply({
          id: EventId.make("usage-nested-provider"),
          type: "provider-thread.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: nested,
        });
        yield* store.apply({
          id: EventId.make("usage-nested-turn"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: {
            ...completed,
            id: ProviderTurnId.make("nested-turn"),
            providerThreadId: nested.id,
            ordinal: 10,
          },
        });
        // Context-only updates cannot erase whole-turn counts.
        const next = {
          ...turn,
          id: ProviderTurnId.make(`next:${turn.id}`),
          ordinal: 2,
          startedAt: DateTime.makeUnsafe("2026-10-13T12:01:00.000Z"),
        };
        yield* store.apply({
          id: EventId.make("usage-next-turn"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: next,
        });
        const shell = (yield* store.getThreadShell(threadId))!;
        assert.equal(shell.usageSummary?.latestTurnTokens, 48_000);
        assert.equal(shell.usageSummary?.threadTokens, 108_000);
        assert.equal(shell.usageSummary?.contextTokens, 10_000);
        const childId = ThreadId.make("native-child");
        yield* store.apply({
          id: EventId.make("usage-child"),
          type: "thread.created",
          threadId: childId,
          occurredAt: now,
          payload: {
            ...thread,
            id: childId,
            lineage: {
              parentThreadId: threadId,
              rootThreadId: threadId,
              relationshipToParent: "subagent",
            },
          },
        });
        const childProvider = {
          ...provider,
          id: ProviderThreadId.make("child-provider"),
          appThreadId: childId,
          ownerNodeId: NodeId.make("child-node"),
        };
        yield* store.apply({
          id: EventId.make("usage-child-provider"),
          type: "provider-thread.updated",
          driver: provider.driver,
          threadId: childId,
          occurredAt: now,
          payload: childProvider,
        });
        yield* store.apply({
          id: EventId.make("usage-child-turn"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId: childId,
          occurredAt: now,
          payload: {
            ...turn,
            id: ProviderTurnId.make("child-turn"),
            providerThreadId: childProvider.id,
          },
        });
        assert.equal(
          (yield* store.getThreadShell(childId))?.usageSummary?.latestTurnTokens,
          48_000,
        );
        assert.equal((yield* store.getThreadShell(childId))?.usageSummary?.threadTokens, 48_000);
        assert.deepEqual((yield* store.getThreadShell(threadId))?.usageSummary, shell.usageSummary);
        const snapshot = yield* store.getShellSnapshot();
        assert.deepEqual(
          snapshot.threads.find((candidate) => candidate.id === threadId)?.usageSummary,
          shell.usageSummary,
        );
        const projection = yield* store.getThreadProjection(threadId);
        assert.deepEqual(
          ProjectionStore.threadShellFromProjection(projection).usageSummary,
          shell.usageSummary,
        );
        yield* sql`DROP TABLE orchestration_v2_projection_thread_usage`;
        yield* ThreadUsageMigration;
        assert.deepEqual((yield* store.getThreadShell(threadId))?.usageSummary, shell.usageSummary);
        const encoded = JSON.stringify(shell.usageSummary);
        assert.isBelow(new TextEncoder().encode(encoded).length, 220);
        assert.notInclude(encoded, "turnId");
        assert.notInclude(encoded, "completed");
        assert.notInclude(encoded, next.id);
        assert.isAtLeast(next.id.length, 77);
        assert.isAtMost(next.id.length, 276);
      }),
  );
});

it.layer(layer)("usage recovery and agreement", (it) => {
  it.effect(
    "skips bad summaries and refresh failures without losing provider projection writes",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* store.apply({
          id: EventId.make("safe-thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        });
        yield* store.apply({
          id: EventId.make("safe-provider"),
          type: "provider-thread.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: provider,
        });
        yield* store.apply({
          id: EventId.make("safe-turn"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: turn,
        });
        yield* sql`UPDATE orchestration_v2_projection_thread_usage SET payload_json = '{' WHERE thread_id = ${threadId}`;
        assert.isUndefined((yield* store.getThreadShell(threadId))?.usageSummary);
        assert.isUndefined((yield* store.getShellSnapshot()).threads[0]?.usageSummary);
        yield* sql`DROP TABLE orchestration_v2_projection_thread_usage`;
        yield* store.apply({
          id: EventId.make("safe-completion"),
          type: "provider-turn.updated",
          driver: provider.driver,
          threadId,
          occurredAt: now,
          payload: { ...turn, status: "completed", completedAt: now },
        });
        assert.equal(
          (yield* store.getThreadProjection(threadId)).providerTurns[0]?.status,
          "completed",
        );
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json = '{' WHERE provider_turn_id = ${turn.id}`;
        yield* ThreadUsageMigration;
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_projection_thread_usage`).length,
          0,
        );
        yield* sql`DROP TABLE orchestration_v2_projection_thread_usage`;
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json = ${JSON.stringify({ ...turn, turnTokenUsage: { ...turn.turnTokenUsage, inputTokens: -1 } })} WHERE provider_turn_id = ${turn.id}`;
        yield* ThreadUsageMigration;
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_projection_thread_usage`).length,
          0,
        );
      }),
  );

  it.effect(
    "matches SQL and memory for handoffs, active native children, ties, unavailable context, and unsupported providers",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        for (const scenario of [
          "handoff",
          "native",
          "tie",
          "unavailable",
          "unsupported",
          "context",
        ] as const) {
          const id = ThreadId.make(`agreement-${scenario}`);
          const firstProvider = {
            ...provider,
            id: ProviderThreadId.make(`${scenario}-p1`),
            appThreadId: id,
            ...(scenario === "native" ? { ownerNodeId: NodeId.make("native-node") } : {}),
            contextUsage: { usedTokens: 20_000, maxTokens: 100_000 },
          };
          const secondProvider = {
            ...firstProvider,
            id: ProviderThreadId.make(`${scenario}-p2`),
            driver: ProviderDriverKind.make(scenario === "unsupported" ? "cursor" : "claudeAgent"),
            ownerNodeId: scenario === "native" ? NodeId.make("other-native-node") : null,
          };
          yield* store.apply({
            id: EventId.make(`${scenario}-thread`),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: { ...thread, id, lineage: { ...thread.lineage, rootThreadId: id } },
          });
          for (const [index, p] of [firstProvider, secondProvider].entries())
            yield* store.apply({
              id: EventId.make(`${scenario}-provider-${index}`),
              type: "provider-thread.updated",
              threadId: id,
              driver: p.driver,
              occurredAt: now,
              payload: p,
            });
          if (scenario === "native")
            yield* store.apply({
              id: EventId.make(`${scenario}-active`),
              type: "provider-thread.updated",
              threadId: id,
              driver: firstProvider.driver,
              occurredAt: now,
              payload: firstProvider,
            });
          const firstTurn = {
            ...turn,
            id: ProviderTurnId.make(`${scenario}-turn:a`),
            providerThreadId: firstProvider.id,
          };
          const secondTurn = {
            ...turn,
            id: ProviderTurnId.make(`${scenario}-turn:Z`),
            providerThreadId: secondProvider.id,
            startedAt: scenario === "tie" ? now : DateTime.makeUnsafe("2026-10-13T12:02:00.000Z"),
            ...(scenario === "unavailable" || scenario === "context"
              ? {
                  turnTokenUsage: undefined,
                  tokenUsage:
                    scenario === "context" ? { ...turn.tokenUsage!, maxTokens: null } : undefined,
                }
              : {}),
          };
          for (const [index, value] of [firstTurn, secondTurn].entries())
            yield* store.apply({
              id: EventId.make(`${scenario}-turn-${index}`),
              type: "provider-turn.updated",
              threadId: id,
              driver: index === 0 ? firstProvider.driver : secondProvider.driver,
              occurredAt: now,
              payload: value,
            });
          const fromSql = (yield* store.getThreadShell(id))?.usageSummary;
          const fromMemory = ProjectionStore.threadShellFromProjection(
            yield* store.getThreadProjection(id),
          ).usageSummary;
          assert.deepEqual(fromSql, fromMemory, scenario);
        }
        const before = (yield* store.getShellSnapshot()).threads;
        yield* sql`DROP TABLE orchestration_v2_projection_thread_usage`;
        yield* ThreadUsageMigration;
        for (const expected of before)
          assert.deepEqual(
            (yield* store.getThreadShell(expected.id))?.usageSummary,
            expected.usageSummary,
            expected.id,
          );
      }),
  );

  it.effect("defers usage scans during historical replay and materializes once per thread", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const replayThreadId = ThreadId.make("replay-thread");
      const replayProvider = {
        ...provider,
        id: ProviderThreadId.make("replay-provider"),
        appThreadId: replayThreadId,
      };
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (at, exit) => {
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
            end(at, exit);
          };
          return span;
        },
      });
      yield* store.apply({
        id: EventId.make("replay-thread"),
        type: "thread.created",
        threadId: replayThreadId,
        occurredAt: now,
        payload: {
          ...thread,
          id: replayThreadId,
          lineage: { ...thread.lineage, rootThreadId: replayThreadId },
        },
      });
      yield* store.apply({
        id: EventId.make("replay-provider"),
        type: "provider-thread.updated",
        threadId: replayThreadId,
        driver: provider.driver,
        occurredAt: now,
        payload: replayProvider,
      });
      statements.length = 0;
      for (let index = 1; index <= 20; index++)
        yield* store
          .apply({
            id: EventId.make(`replay-${index}`),
            type: "provider-turn.updated",
            threadId: replayThreadId,
            driver: provider.driver,
            occurredAt: now,
            payload: {
              ...turn,
              providerThreadId: replayProvider.id,
              id: ProviderTurnId.make(`replay-turn-${index}`),
              ordinal: index,
            },
          })
          .pipe(Effect.provideService(DeferThreadUsageSummary, true), Effect.withTracer(tracer));
      assert.equal(statements.filter((query) => query.includes("OVER ()")).length, 0);
      const threadCount = (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]!.count;
      yield* refreshAllThreadUsageSummaries.pipe(Effect.withTracer(tracer));
      assert.equal(statements.filter((query) => query.includes("OVER ()")).length, threadCount);
      assert.equal(
        (yield* store.getThreadShell(replayThreadId))?.usageSummary?.threadTokens,
        20 * 48_000,
      );
    }),
  );
});

const usageEvents = (
  appThread = thread,
  providerThread = provider,
  providerTurn = turn,
): ReadonlyArray<OrchestrationV2DomainEvent> => [
  {
    id: EventId.make(`${appThread.id}-created`),
    type: "thread.created",
    threadId: appThread.id,
    occurredAt: now,
    payload: appThread,
  },
  {
    id: EventId.make(`${appThread.id}-provider`),
    type: "provider-thread.updated",
    driver: providerThread.driver,
    threadId: appThread.id,
    occurredAt: now,
    payload: providerThread,
  },
  {
    id: EventId.make(`${appThread.id}-turn`),
    type: "provider-turn.updated",
    driver: providerThread.driver,
    threadId: appThread.id,
    occurredAt: now,
    payload: providerTurn,
  },
];
const seedUsage = (appThread = thread, providerThread = provider, providerTurn = turn) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    for (const event of usageEvents(appThread, providerThread, providerTurn))
      yield* store.apply(event);
  });
const usageServiceWith = (tokenPricer: UsageService["Service"]["tokenPricer"]) =>
  UsageService.of({
    tokenPricer,
    refreshRates: Effect.die("unused"),
    readSummary: () => Effect.die("unused"),
  });
const withPricer =
  (pricer: TokenPricer) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ThreadUsagePricer, pricer),
      Effect.provideService(UsageService, usageServiceWith(Effect.succeed(pricer))),
    );

const sinkLayer = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  ),
);
it.layer(sinkLayer)("event writes that refresh usage", (it) => {
  // Pricing reads settings, whose reload queries the database writer; waiting
  // for it inside a write transaction deadlocked every write on 2026-10-14.
  it.effect("price outside the write transaction", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const pricedInTransaction: Array<boolean> = [];
      const tokenPricer = Effect.serviceOption(sql.transactionService).pipe(
        Effect.map((transaction): TokenPricer => {
          pricedInTransaction.push(Option.isSome(transaction));
          return (_model, totals) => totals.outputTokens / 1000;
        }),
      );
      yield* sink
        .write({ events: usageEvents(thread, provider, { ...turn, status: "completed" }) })
        .pipe(Effect.provideService(UsageService, usageServiceWith(tokenPricer)));
      assert.deepEqual(pricedInTransaction, [false]);
      assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, 8);
    }),
  );
});

it.layer(layer)("thread cost estimates", (it) => {
  it.effect("backfills a completed thread without a new turn and does not persist a percent", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* seedUsage(thread, provider, { ...turn, status: "completed", completedAt: now });
      assert.isUndefined((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd);
      yield* sql`UPDATE orchestration_v2_projection_thread_usage SET payload_json = json_set(payload_json, '$.weeklyLimitPercent', 81) WHERE thread_id = ${threadId}`;
      let calls = 0;
      const price: TokenPricer = (_model, totals) => {
        calls++;
        return totals.outputTokens / 1000;
      };
      yield* backfillThreadUsageCosts.pipe(withPricer(price));
      assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, 8);
      assert.isUndefined((yield* store.getThreadShell(threadId))?.usageSummary?.weeklyLimitPercent);
      const stored = (yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_thread_usage WHERE thread_id = ${threadId}`)[0]!
        .payload_json;
      assert.notInclude(stored, "weeklyLimitPercent");
      const before = calls;
      yield* backfillThreadUsageCosts.pipe(withPricer(price));
      assert.equal(calls, before, "already priced threads are not rescanned on restart");
    }),
  );

  it.effect("does not rescan a thread whose model has no price on every restart", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedUsage(thread, provider, { ...turn, status: "completed", completedAt: now });
      let calls = 0;
      const unpriced: TokenPricer = () => {
        calls++;
        return null;
      };
      yield* backfillThreadUsageCosts.pipe(withPricer(unpriced));
      assert.equal(calls, 1);
      assert.isUndefined((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd);
      yield* backfillThreadUsageCosts.pipe(withPricer(unpriced));
      assert.equal(calls, 1);
    }),
  );

  it.effect("prices native Codex child turns with no run attempt using their own metadata", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const owner = NodeId.make("cost-native-node");
      const childProvider = {
        ...provider,
        ownerNodeId: owner,
        nativeMetadata: {
          modelSelection: {
            instanceId: providerInstanceId,
            model: "native-model",
            options: [{ id: "serviceTier", value: "priority" }],
          },
        },
      };
      yield* seedUsage(thread, childProvider, { ...turn, runAttemptId: null });
      const observed: unknown[] = [];
      yield* refreshThreadUsageSummary(threadId).pipe(
        withPricer((model, totals, speed) => {
          observed.push([model, totals, speed]);
          return totals.outputTokens / 1000;
        }),
      );
      assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, 8);
      assert.deepEqual(observed, [
        [
          "native-model",
          {
            uncachedInputTokens: 10_000,
            cachedInputTokens: 30_000,
            cacheCreationTokens: 0,
            outputTokens: 8_000,
            reasoningTokens: 0,
          },
          "fast",
        ],
      ]);
      // Older native records carry only the subagent model. They must still be priced.
      const task: OrchestrationV2Subagent = {
        id: owner,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: provider.driver,
        providerInstanceId,
        providerThreadId: provider.id,
        childThreadId: threadId,
        nativeTaskRef: null,
        prompt: "child",
        title: null,
        model: "task-model",
        status: "completed",
        result: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("native-task-model"),
        type: "subagent.updated",
        threadId,
        driver: provider.driver,
        occurredAt: now,
        payload: task,
      });
      yield* store.apply({
        id: EventId.make("native-no-metadata"),
        type: "provider-thread.updated",
        threadId,
        driver: provider.driver,
        occurredAt: now,
        payload: { ...childProvider, nativeMetadata: null },
      });
      yield* refreshThreadUsageSummary(threadId).pipe(
        withPricer((model) => (model === "task-model" ? 12 : null)),
      );
      assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, 12);
    }),
  );

  it.effect("uses each run's recorded speed instead of the thread's current options", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedUsage();
      const runId = RunId.make("speed-run");
      const attemptId = RunAttemptId.make("speed-attempt");
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection: {
          instanceId: providerInstanceId,
          model: "priced",
          options: [{ id: "serviceTier", value: "priority" }],
        },
        providerThreadId: provider.id,
        userMessageId: MessageId.make("speed-message"),
        rootNodeId: turn.nodeId,
        activeAttemptId: attemptId,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* store.apply({
        id: EventId.make("speed-run"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: run,
      });
      yield* store.apply({
        id: EventId.make("speed-attempt"),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: turn.nodeId,
          providerInstanceId,
          providerThreadId: provider.id,
          providerTurnId: turn.id,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* store
        .apply({
          id: EventId.make("speed-turn"),
          type: "provider-turn.updated",
          threadId,
          driver: provider.driver,
          occurredAt: now,
          payload: { ...turn, runAttemptId: attemptId },
        })
        .pipe(
          withPricer(
            (_model, totals, speed) => (totals.outputTokens / 1000) * (speed === "fast" ? 2 : 1),
          ),
        );
      assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, 16);
      for (const [options, expected] of [
        [[{ id: "serviceTier", value: "priority" }], 16],
        [[{ id: "serviceTier", value: "ultrafast" }], 48],
        [[{ id: "fastMode", value: true }], 16],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`speed-${expected}-${options[0].id}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, modelSelection: { ...run.modelSelection, options } },
        });
        yield* refreshThreadUsageSummary(threadId).pipe(
          withPricer(
            (_model, totals, speed) =>
              (totals.outputTokens / 1000) * (speed === "ultrafast" ? 6 : speed === "fast" ? 2 : 1),
          ),
        );
        assert.equal((yield* store.getThreadShell(threadId))?.usageSummary?.costUsd, expected);
      }
    }),
  );
});
