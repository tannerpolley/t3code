import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ServerProvider,
  type UsageDay,
  type UsageLimitSourceSnapshot,
  type UsageSummary,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { compactUsageLimits, compactUsageSummary } from "./compact.ts";
import * as UsageHandlers from "./handlers.ts";
import { readThreadUsage, UsageThreadsResult } from "./readThreads.ts";
import { UsageToolkit } from "./tools.ts";
import { usageWindow, zonedDayStartIso } from "./window.ts";

const day = (value: string) => value as UsageDay;

const summaryFixture = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-11-28T12:00:00.000Z",
  timeZone: "UTC",
  sinceDay: day("2026-11-22"),
  untilDay: day("2026-11-28"),
  buckets: [
    {
      day: day("2026-11-28"),
      provider: "claude",
      model: "claude-opus",
      sourcePath: "/home/secret/.claude/session.jsonl",
      totals: {
        uncachedInputTokens: 1_000,
        cachedInputTokens: 4_000,
        cacheCreationTokens: 1_000,
        outputTokens: 500,
        reasoningTokens: 100,
      },
      costUsd: 1.5,
      cacheSavingsUsd: 0.4,
      categoryCostUsd: { input: 0.2, cacheRead: 0.1, cacheWrite: 0.05, output: 0.15 },
      fastCostUsd: 0.1,
      speedPremiumUsd: 0.05,
      costSource: "modelPriced",
      records: 2,
      unpricedRecords: 0,
      sessions: 1,
    },
    {
      day: day("2026-11-27"),
      provider: "codex",
      model: "gpt-test",
      totals: {
        uncachedInputTokens: 200,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
      costUsd: 0.25,
      cacheSavingsUsd: 0,
      costSource: "providerReported",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "host-secret",
        provider: "claude",
        resolvedHomePath: "/home/secret/.claude",
        volumeId: "vol-secret",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 2,
      message: "Could not read /home/secret/.claude",
    },
    {
      fingerprint: {
        hostId: "host-secret",
        provider: "codex",
        resolvedHomePath: "/home/secret/.codex",
        volumeId: "vol-secret",
      },
      status: "partial",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 1,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: {
    status: "cached",
    source: "https://secret.example/rates",
    fetchedAt: null,
    knownModels: 10,
  },
  scanDurationMs: 1,
} satisfies UsageSummary;

const window = {
  sinceDay: day("2026-11-22"),
  untilDay: day("2026-11-28"),
  timeZone: "UTC",
  days: 7,
};

it("compacts a saved scan into totals without paths or host ids", () => {
  const ready = compactUsageSummary({ summary: summaryFixture, window, topModels: 12 });
  expect(ready).toMatchObject({
    status: "ready",
    totals: {
      tokens: {
        uncachedInput: 1200,
        cachedInput: 4000,
        cacheWrite: 1000,
        output: 600,
        reasoning: 100,
        total: 6800,
      },
      cacheHitRate: 0.6452,
      costUsd: 1.75,
      cacheSavingsUsd: 0.4,
      costPerMillionTokens: 257.35,
      records: 3,
      sessions: 3,
      categoryCostUsd: { input: 0.2, cacheRead: 0.1, cacheWrite: 0.05, output: 0.15, other: 1.25 },
      speedUsd: { standard: 1.65, fast: 0.1, ultrafast: 0, premium: 0.05 },
      costSourceShare: { modelPriced: 0.6667, providerReported: 0.3333, unpriced: 0 },
    },
    byDay: [
      { day: "2026-11-27", tokens: 300, costUsd: 0.25 },
      { day: "2026-11-28", tokens: 6500, costUsd: 1.5 },
    ],
  });
  expect(ready.byProvider.map((row) => row.provider)).toEqual(["claude", "codex"]);
  expect(ready.byModel.map((row) => row.model)).toEqual(["claude-opus", "gpt-test"]);
  const modelOnly = compactUsageSummary({
    summary: summaryFixture,
    window,
    topModels: 1,
    model: "gpt-test",
  });
  expect(modelOnly.byModel.map((row) => row.model)).toEqual(["gpt-test"]);
  expect(modelOnly.totals.sessions).toBeNull();
  expect(modelOnly.totals.tokens.total).toBe(300);
  const encoded = JSON.stringify(ready);
  expect(encoded).not.toContain("/home/secret");
  expect(encoded).not.toContain("host-secret");
  expect(encoded).not.toContain("vol-secret");
  expect(encoded).not.toContain("secret.example");
});

it("keeps limit snapshots free of emails, credential ids, and source addresses", () => {
  const provider = {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    usageLimits: {
      checkedAt: "2026-11-28T00:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5-hour",
          usedPercent: 40,
          resetsAt: "2026-11-28T05:00:00.000Z",
          windowDurationMins: 300,
        },
      ],
      credentialFingerprint: "fp-secret",
      resetCredits: {
        availableCount: 2,
        nextExpiresAt: "2026-12-01T00:00:00.000Z",
        nextCreditId: "credit-secret",
      },
    },
  } as unknown as ServerProvider;
  const sources = [
    {
      id: "hub",
      kind: "cliproxy",
      label: "127.0.0.1:8317",
      origin: "http://127.0.0.1:8317",
      endpoint: "http://127.0.0.1:8317/management",
      checkedAt: "2026-11-28T00:00:00.000Z",
      error: "management key sk-secret",
      accounts: [
        {
          id: "auth-file.json",
          driver: "claude",
          email: "ada@example.com",
          plan: "Max",
          workspaceId: "ws-secret",
          usageLimits: {
            checkedAt: "2026-11-28T00:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 80 }],
            credentialFingerprint: "fp-secret",
            resetCredits: {
              availableCount: 1,
              nextCreditId: "credit-secret",
              options: [
                {
                  creditId: "credit-secret",
                  label: "Weekly reset",
                  description: "sk-secret",
                  availableCount: 1,
                },
              ],
            },
          },
        },
      ],
    },
  ] as unknown as ReadonlyArray<UsageLimitSourceSnapshot>;
  const limits = compactUsageLimits({ providers: [provider], sources });
  expect(limits.accounts).toEqual([
    expect.objectContaining({
      provider: "claude",
      plan: "Max",
      source: "hub",
      windows: [expect.objectContaining({ usedPercent: 80, remainingPercent: 20 })],
      resetCredits: {
        availableCount: 1,
        options: [{ label: "Weekly reset", availableCount: 1 }],
      },
    }),
    expect.objectContaining({
      provider: "codex",
      instanceId: "codex",
      source: "provider",
      enabled: true,
      windows: [
        expect.objectContaining({
          remainingPercent: 60,
          resetsAt: "2026-11-28T05:00:00.000Z",
          windowDurationMins: 300,
        }),
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: "2026-12-01T00:00:00.000Z" },
    }),
  ]);
  const encoded = JSON.stringify(limits);
  for (const secret of [
    "ada@example.com",
    "fp-secret",
    "credit-secret",
    "sk-secret",
    "127.0.0.1",
    "auth-file.json",
    "ws-secret",
  ]) {
    expect(encoded, secret).not.toContain(secret);
  }
});

const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const encodeThreadUsage = Schema.encodeEffect(UsageThreadsResult);

it("builds calendar windows and local midnights", () => {
  expect(usageWindow(7, at("2026-11-28T15:00:00.000Z"), "UTC")).toMatchObject({
    sinceDay: "2026-11-22",
    untilDay: "2026-11-28",
    timeZone: "UTC",
    days: 7,
  });
  expect(usageWindow(1, at("2026-11-28T03:00:00.000Z"), "America/New_York").untilDay).toBe(
    "2026-11-27",
  );
  expect(zonedDayStartIso("2026-11-28", "UTC")).toBe("2026-11-28T00:00:00.000Z");
  expect(zonedDayStartIso("2026-11-28", "America/New_York")).toBe("2026-11-28T05:00:00.000Z");
  expect(zonedDayStartIso("2026-07-01", "America/New_York")).toBe("2026-07-01T04:00:00.000Z");
  expect(() => usageWindow(7, at("2026-11-28T00:00:00.000Z"), "Not/AZone")).toThrow(RangeError);
});

const readOnlyScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-usage"),
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "mcp-usage-test",
  thread: undefined,
  client: { sessionId: "session-1", label: "Token Optimizer", access: "read-only" },
};

const dependencies = (
  readCachedSummary: UsageService.UsageService["Service"]["readCachedSummary"],
) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, readOnlyScope),
    Layer.mock(UsageService.UsageService)({ readCachedSummary }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeSqliteClient.layer({ filename: ":memory:" }),
  );

const callSummary = (
  readCachedSummary: UsageService.UsageService["Service"]["readCachedSummary"],
  args: { readonly days?: number; readonly timeZone?: string } = {},
) =>
  Effect.gen(function* () {
    const layer = dependencies(readCachedSummary);
    const toolkit = yield* UsageToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(UsageHandlers.layer).pipe(Layer.provide(layer)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_usage_summary", args)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer));
    return result.at(-1)?.result;
  });

it.effect("a read-only client reads the saved summary for the requested window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-28T15:00:00.000Z"));
    const requested = yield* Ref.make<unknown>(undefined);
    const result = yield* callSummary((input) =>
      Ref.set(requested, input).pipe(Effect.as(summaryFixture)),
    );
    expect(yield* Ref.get(requested)).toEqual({
      sinceDay: "2026-11-22",
      untilDay: "2026-11-28",
      timeZone: "UTC",
    });
    expect(result).toMatchObject({ status: "ready", totals: { tokens: { total: 6800 } } });
    expect(JSON.stringify(result)).not.toContain("/home/secret");
  }),
);

it.effect("reports a window the saved scan does not cover without starting one", () =>
  Effect.gen(function* () {
    const result = yield* callSummary(() => Effect.undefined);
    expect(result).toMatchObject({ status: "not_cached" });
    expect(JSON.stringify(result)).toContain("does not start a scan");
  }),
);

it.effect("stops waiting when the saved scan is not ready", () =>
  Effect.gen(function* () {
    const fiber = yield* callSummary(() => Effect.never).pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result).toMatchObject({ status: "not_cached" });
    expect(JSON.stringify(result)).toContain("not ready");
  }),
);

it.effect("rejects a time zone that is not an IANA name", () =>
  Effect.gen(function* () {
    const result = yield* callSummary(() => Effect.die("should not read"), {
      timeZone: "Not/AZone",
    });
    expect(result).toMatchObject({ code: "invalid_request" });
  }),
);

it.layer(Sqlite.layerMemory)("thread usage", (it) => {
  it.effect("ranks bounded recent turns and context pressure without message text", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const secret = "DO NOT LEAK this prompt";
      const workspace = "/secret/workspace-root";
      const inWindow = "2026-11-28T01:00:00.000Z";
      const before = "2026-11-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'Billing', ${workspace}, '[]', ${inWindow}, ${inWindow})
      `;
      const thread = (
        id: string,
        title: string,
        updatedAt: string,
        providerThreadId: string,
        deletedAt: string | null = null,
      ) =>
        sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${title}, 'codex', 'full-access', 'default',
            ${providerThreadId}, ${updatedAt}, ${updatedAt}, ${deletedAt}, ${JSON.stringify({ secret })}
          )
        `;
      yield* thread("thread-a", "Ship the parser", inWindow, "pt-a");
      yield* thread("thread-b", "Explain the bill", inWindow, "pt-b");
      yield* thread("thread-old", "Ancient", before, "pt-old");
      yield* thread("thread-deleted", "Gone", inWindow, "pt-deleted", inWindow);
      const providerThread = (id: string, threadId: string) =>
        sql`
          INSERT INTO orchestration_v2_projection_provider_threads (
            provider_thread_id, thread_id, provider, status, updated_at, payload_json
          ) VALUES (${id}, ${threadId}, 'codex', 'running', ${inWindow}, '{}')
        `;
      yield* providerThread("pt-a", "thread-a");
      yield* providerThread("pt-b", "thread-b");
      yield* providerThread("pt-old", "thread-old");
      const turn = (input: {
        readonly id: string;
        readonly threadId: string;
        readonly providerThreadId: string;
        readonly ordinal: number;
        readonly completedAt: string;
        readonly output: number;
        readonly localCommand?: true;
        readonly tokenUsage?: {
          readonly usedTokens: number;
          readonly maxTokens: number;
          readonly autoCompactThreshold?: number;
        };
      }) =>
        sql`
          INSERT INTO orchestration_v2_projection_provider_turns (
            provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status,
            completed_at, payload_json
          ) VALUES (
            ${input.id}, ${input.threadId}, ${input.providerThreadId}, ${`node-${input.id}`},
            ${input.ordinal}, 'completed', ${input.completedAt},
            ${JSON.stringify({
              secret,
              model: input.threadId === "thread-a" ? "gpt-a" : "gpt-b",
              serviceTier: "fast",
              ...(input.tokenUsage === undefined
                ? {}
                : {
                    tokenUsage: {
                      ...input.tokenUsage,
                      updatedAt: input.completedAt,
                    },
                  }),
              turnTokenUsage: {
                usageScope: "main_agent",
                usageStatus: "complete",
                inputTokens: 0,
                outputTokens: input.output,
                hasSubagents: false,
                ...(input.localCommand === undefined ? {} : { localCommand: true }),
              },
            })}
          )
        `;
      yield* turn({
        id: "a1",
        threadId: "thread-a",
        providerThreadId: "pt-a",
        ordinal: 1,
        completedAt: inWindow,
        output: 10,
        tokenUsage: { usedTokens: 1_000, maxTokens: 100_000 },
      });
      for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
        yield* turn({
          id: `b${ordinal}`,
          threadId: "thread-b",
          providerThreadId: "pt-b",
          ordinal,
          completedAt: ordinal === 10 ? before : inWindow,
          output: ordinal === 10 ? 5_000 : ordinal === 9 ? 999 : 1,
          ...(ordinal === 9 ? { localCommand: true as const } : {}),
          ...(ordinal === 8
            ? {
                tokenUsage: {
                  usedTokens: 90_000,
                  maxTokens: 200_000,
                  autoCompactThreshold: 100_000,
                },
              }
            : {}),
        });
      }
      yield* turn({
        id: "old",
        threadId: "thread-old",
        providerThreadId: "pt-old",
        ordinal: 1,
        completedAt: before,
        output: 100,
      });
      const result = yield* readThreadUsage({
        sinceIso: "2026-11-21T00:00:00.000Z",
        window,
        limit: 15,
      });
      const encoded = yield* encodeThreadUsage(result);
      expect(encoded.threads.map((row) => row.threadId)).toEqual(["thread-a", "thread-b"]);
      expect(result.threads.map((thread) => [thread.threadId, thread.tokens.total])).toEqual([
        ["thread-a", 10],
        ["thread-b", 6],
      ]);
      expect(result.threads[1]).toMatchObject({
        turnsCounted: 6,
        context: {
          usedTokens: 90_000,
          autoCompactThreshold: 100_000,
          fillRatio: 0.9,
          nearAutoCompaction: true,
          basis: "autoCompact",
        },
      });
      expect(result.threads[0]?.context).toMatchObject({
        nearAutoCompaction: false,
        basis: "max",
        fillRatio: 0.01,
      });
      expect(result.projects).toEqual([
        { projectId: "project-1", title: "Billing", threads: 2, tokens: 16 },
      ]);
      expect(result.nearCompaction.map((thread) => thread.threadId)).toEqual(["thread-b"]);
      expect(result.threadsConsidered).toBe(2);
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(workspace);
      expect(text).not.toContain("5000");
      expect(text).not.toContain("999");
      expect(text).not.toContain("thread-old");
      expect(text).not.toContain("thread-deleted");
    }),
  );
});
