import { expect, it } from "@effect/vitest";
import type { UsageSummary } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageAnalytics from "./UsageAnalytics.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageService from "./UsageService.ts";

const emptySummary = {
  contractVersion: 6,
  readAt: "2026-11-28T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-11-22",
  untilDay: "2026-11-28",
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "rates", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
} as unknown as UsageSummary;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_active_shell_idx
    ON orchestration_v2_projection_threads(updated_at, thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      run_attempt_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_turns_thread_idx ON orchestration_v2_projection_provider_turns(thread_id)`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_usage_idx
    ON orchestration_v2_projection_provider_turns(
      provider_thread_id,
      julianday(json_extract(payload_json, '$.tokenUsage.updatedAt')) DESC,
      ordinal DESC
    )
    WHERE json_type(payload_json, '$.tokenUsage') = 'object'
  `;
  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project-a', 'Analytics', '/secret/home/repo', '{}',
      '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
    )
  `;

  const insertThread = (input: {
    readonly id: string;
    readonly title: string;
    readonly providerThreadId: string;
    readonly archived?: boolean;
    readonly subagent?: boolean;
  }) =>
    sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, payload_json
      ) VALUES (
        ${input.id}, 'project-a', ${input.title}, 'codex', 'full-access', 'default',
        ${input.providerThreadId}, '2026-11-28T12:00:00.000Z', '2026-11-28T12:00:00.000Z',
        ${input.archived === true ? "2026-11-28T13:00:00.000Z" : null},
        ${JSON.stringify({
          activeProviderThreadId: input.providerThreadId,
          ...(input.subagent === true ? { lineage: { relationshipToParent: "subagent" } } : {}),
        })}
      )
    `;

  const insertTurn = (input: {
    readonly id: string;
    readonly threadId: string;
    readonly providerThreadId: string;
    readonly ordinal: number;
    readonly completedAt: string;
    readonly payload: unknown;
  }) =>
    sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, completed_at, payload_json
      ) VALUES (
        ${input.id}, ${input.threadId}, ${input.providerThreadId}, ${`node-${input.id}`},
        ${input.ordinal}, 'completed', ${input.completedAt}, ${JSON.stringify(input.payload)}
      )
    `;

  yield* insertThread({
    id: "thread-a",
    title: "Compile the report",
    providerThreadId: "provider-a",
  });
  yield* insertThread({
    id: "thread-b",
    title: "Child",
    providerThreadId: "provider-b",
    subagent: true,
  });
  yield* insertThread({
    id: "thread-archived",
    title: "Old work",
    providerThreadId: "provider-archived",
    archived: true,
  });
  yield* insertTurn({
    id: "turn-counted",
    threadId: "thread-a",
    providerThreadId: "provider-a",
    ordinal: 2,
    completedAt: "2026-11-28T12:00:00.000Z",
    payload: {
      model: "gpt-test",
      serviceTier: "priority",
      turnTokenUsage: {
        usageStatus: "complete",
        inputTokens: 1000,
        cachedInputTokens: 800,
        cacheCreationTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        otherUsage: { inputTokens: 5, outputTokens: 7 },
        hasSubagents: false,
      },
      tokenUsage: {
        usedTokens: 180000,
        maxTokens: 200000,
        autoCompactThreshold: 190000,
        updatedAt: "2026-11-28T12:00:00.000Z",
      },
    },
  });
  yield* insertTurn({
    id: "turn-old",
    threadId: "thread-a",
    providerThreadId: "provider-a",
    ordinal: 1,
    completedAt: "2026-11-01T00:00:00.000Z",
    payload: {
      model: "old-model",
      turnTokenUsage: {
        usageStatus: "complete",
        inputTokens: 9000,
        outputTokens: 9000,
        hasSubagents: false,
      },
      tokenUsage: { usedTokens: 999999, updatedAt: "2026-11-01T00:00:00.000Z" },
    },
  });
  yield* insertTurn({
    id: "turn-local",
    threadId: "thread-a",
    providerThreadId: "provider-a",
    ordinal: 3,
    completedAt: "2026-11-28T12:30:00.000Z",
    payload: {
      model: "local",
      turnTokenUsage: {
        usageStatus: "complete",
        inputTokens: 5000,
        outputTokens: 5000,
        localCommand: true,
        hasSubagents: false,
      },
    },
  });
  yield* insertTurn({
    id: "turn-child",
    threadId: "thread-b",
    providerThreadId: "provider-b",
    ordinal: 1,
    completedAt: "2026-11-28T11:00:00.000Z",
    payload: {
      model: "small",
      turnTokenUsage: {
        usageStatus: "partial",
        inputTokens: 10,
        outputTokens: 0,
        hasSubagents: false,
      },
    },
  });
  yield* insertTurn({
    id: "turn-archived",
    threadId: "thread-archived",
    providerThreadId: "provider-archived",
    ordinal: 1,
    completedAt: "2026-11-28T10:00:00.000Z",
    payload: {
      turnTokenUsage: {
        usageStatus: "complete",
        inputTokens: 8000,
        outputTokens: 8000,
        hasSubagents: false,
      },
    },
  });
});

const calls: Array<{ readonly input: unknown; readonly options: unknown }> = [];

const layer = UsageAnalytics.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(
    Layer.mock(UsageService.UsageService)({
      readSummary: (input, options) => {
        calls.push({ input, options });
        return Effect.succeed(emptySummary);
      },
    }),
  ),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) })),
);

it.effect("sums in-window turns for the newest active threads and their context", () =>
  Effect.gen(function* () {
    yield* seed;
    const report = yield* (yield* UsageAnalytics.UsageAnalytics).readThreads({
      sinceDay: "2026-11-22",
      untilDay: "2026-11-28",
      timeZone: "UTC",
    });
    expect(report.truncated).toBe(false);
    expect(report.threads.map((thread) => thread.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(report.threads[0]).toMatchObject({
      title: "Compile the report",
      projectTitle: "Analytics",
      subagent: false,
      model: "gpt-test",
      serviceTier: "priority",
      inputTokens: 1000,
      cachedInputTokens: 800,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      otherTokens: 12,
      totalTokens: 1062,
      cacheHitRate: 0.8,
      turns: 1,
      partialTurns: 0,
    });
    expect(report.threads[1]).toMatchObject({ subagent: true, totalTokens: 10, partialTurns: 1 });
    expect(report.projects[0]).toMatchObject({
      projectId: "project-a",
      title: "Analytics",
      threads: 2,
      totalTokens: 1072,
      cacheHitRate: 0.7921,
    });
    expect(report.nearAutoCompaction).toMatchObject([
      {
        threadId: "thread-a",
        usedTokens: 180000,
        maxTokens: 200000,
        autoCompactThreshold: 190000,
        fillRatio: 0.9474,
      },
    ]);
    expect(report.highestContextFill).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("/secret");
  }).pipe(Effect.provide(layer)),
);

it.effect("includes an archived thread only when it is requested", () =>
  Effect.gen(function* () {
    yield* seed;
    const analytics = yield* UsageAnalytics.UsageAnalytics;
    const hidden = yield* analytics.readThreads({
      sinceDay: "2026-11-22",
      untilDay: "2026-11-28",
    });
    expect(hidden.threads.map((thread) => thread.threadId)).not.toContain("thread-archived");
    const shown = yield* analytics.readThreads({
      sinceDay: "2026-11-22",
      untilDay: "2026-11-28",
      threadId: "thread-archived",
    });
    expect(shown.threads).toMatchObject([{ threadId: "thread-archived", totalTokens: 16000 }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("asks the usage cache for a summary and skips the turn-history lookup", () =>
  Effect.gen(function* () {
    calls.length = 0;
    const analytics = yield* UsageAnalytics.UsageAnalytics;
    const rejected = yield* analytics
      .readSummary({ sinceDay: "2026-01-01", untilDay: "2026-02-01" })
      .pipe(Effect.flip);
    expect(rejected.reason).toBe("invalidWindow");
    expect(rejected.detail).toBe("Date range is 32 days. The maximum is 31.");
    expect(calls).toEqual([]);

    yield* analytics.readSummary({ timeZone: "UTC" });
    expect(calls).toMatchObject([
      {
        input: {
          sinceDay: "1969-12-26",
          untilDay: "1970-01-01",
          timeZone: "UTC",
          provisional: true,
        },
        options: { skipServiceTierResolution: true },
      },
    ]);
  }).pipe(Effect.provide(layer)),
);
