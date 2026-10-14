import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import ThreadUsageMigration from "../persistence/ForkMigrations/010_ThreadUsageSummary.ts";
import { deriveThreadUsageSummary } from "./ThreadUsageSummary.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

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
  id: ProviderTurnId.make("usage-turn"),
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
        const next = {
          ...turn,
          id: ProviderTurnId.make("next-turn"),
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
        assert.isBelow(new TextEncoder().encode(JSON.stringify(shell.usageSummary)).length, 350);
      }),
  );
});
