import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  compactUsageLimits,
  compactUsageSummary,
  resolveHourlyBounds,
  resolveUsageWindow,
  UsageLimitsReport,
  UsageSummaryReport,
  zonedDayStartIso,
} from "./usageReport.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummaryReport);
const decodeLimits = Schema.decodeUnknownSync(UsageLimitsReport);

function bucket(
  overrides: Partial<UsageBucket> & Pick<UsageBucket, "provider" | "model">,
): UsageBucket {
  return {
    day: "2026-11-28" as UsageBucket["day"],
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 0,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    unpricedTokens: 0,
    sessions: 1,
    ...overrides,
  };
}

const summary = (buckets: readonly UsageBucket[]): UsageSummary =>
  ({
    contractVersion: 6,
    readAt: "2026-11-28T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-11-22",
    untilDay: "2026-11-28",
    buckets,
    sources: [
      {
        fingerprint: {
          hostId: "host",
          provider: "claude",
          resolvedHomePath: "/secret/home/claude",
          volumeId: "vol",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 4,
        message: "read /secret/home/claude",
        refreshing: true,
      },
    ],
    pricing: {
      status: "fresh",
      source: "https://secret.example/rates",
      fetchedAt: "2026-11-28T00:00:00.000Z",
      knownModels: 12,
    },
    scanDurationMs: 3,
  }) as unknown as UsageSummary;

it("compacts usage into totals, cache hit rate, and cost per million", () => {
  const report = decodeSummary(
    compactUsageSummary(
      summary([
        bucket({
          provider: "claude",
          model: "opus",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 300,
            cacheCreationTokens: 50,
            outputTokens: 40,
            reasoningTokens: 10,
          },
          costUsd: 1.5,
          cacheSavingsUsd: 0.4,
          categoryCostUsd: { input: 0.2, cacheRead: 0.1, cacheWrite: 0.3, output: 0.9 },
          fastCostUsd: 0,
          ultrafastCostUsd: 0,
          speedPremiumUsd: 0,
          records: 2,
        }),
        bucket({
          provider: "codex",
          model: "gpt",
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 5,
            reasoningTokens: 0,
          },
          costUsd: 0.2,
        }),
      ]),
    ),
  );

  expect(report.totals.tokens).toMatchObject({
    uncachedInputTokens: 110,
    cachedInputTokens: 300,
    cacheCreationTokens: 50,
    outputTokens: 45,
    reasoningTokens: 10,
    totalTokens: 505,
  });
  expect(report.totals.cacheHitRate).toBe(0.6522);
  expect(report.totals.costUsd).toBe(1.7);
  expect(report.totals.cacheSavingsUsd).toBe(0.4);
  expect(report.totals.costPerMillionUsd).toBe(3366.3366);
  expect(report.totals.categoryCostUsd).toEqual({
    input: 0.2,
    cacheRead: 0.1,
    cacheWrite: 0.3,
    output: 0.9,
    other: 0.2,
  });
  expect(report.byProvider.map((row) => row.provider)).toEqual(["claude", "codex"]);
  expect(report.byModel[0]).toMatchObject({
    provider: "claude",
    model: "opus",
    cacheHitRate: 0.6667,
    costPerMillionUsd: 3061.2245,
  });
  expect(report.refreshing).toBe(true);
  expect(report.pricing).toEqual({ status: "fresh", knownModels: 12 });
  const encoded = JSON.stringify(report);
  expect(encoded).not.toContain("/secret");
  expect(encoded).not.toContain("secret.example");
  expect(encoded).not.toContain("read /secret");
});

it("leaves cost per million empty when every record is unpriced and caps models", () => {
  const models = Array.from({ length: 26 }, (_, index) =>
    bucket({
      provider: "pi",
      model: `model-${String(index).padStart(2, "0")}`,
      totals: {
        uncachedInputTokens: index,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costSource: "unpriced",
      unpricedRecords: 1,
      unpricedTokens: index,
      records: 1,
    }),
  );
  const report = decodeSummary(compactUsageSummary(summary(models)));
  expect(report.byModel).toHaveLength(25);
  expect(report.omittedModels).toBe(1);
  expect(report.byModel[0]?.model).toBe("model-25");
  expect(report.byModel[0]?.costPerMillionUsd).toBeNull();
  expect(report.byModel[0]?.unpriced).toBe(true);
});

it("resolves day windows in the requested time zone and rejects an oversized range", () => {
  const nowMs = Date.parse("2026-11-28T15:00:00.000Z");
  expect(resolveUsageWindow({ nowMs })).toMatchObject({
    ok: true,
    sinceDay: "2026-11-22",
    untilDay: "2026-11-28",
    timeZone: "UTC",
    sinceIso: "2026-11-22T00:00:00.000Z",
    untilIso: "2026-11-29T00:00:00.000Z",
  });
  expect(
    resolveUsageWindow({
      nowMs: Date.parse("2026-11-28T07:00:00.000Z"),
      timeZone: "America/Los_Angeles",
    }),
  ).toMatchObject({
    ok: true,
    untilDay: "2026-11-27",
  });
  expect(zonedDayStartIso("2026-01-15", "America/Los_Angeles")).toBe("2026-01-15T08:00:00.000Z");
  expect(
    resolveUsageWindow({ sinceDay: "2026-01-01", untilDay: "2026-02-01", nowMs }),
  ).toMatchObject({
    ok: false,
    detail: "Date range is 32 days. The maximum is 31.",
  });
  expect(resolveUsageWindow({ sinceDay: "2026-11-28", nowMs })).toMatchObject({
    ok: false,
    detail: "Pass sinceDay and untilDay together, or omit both for the last 7 days.",
  });
  expect(resolveUsageWindow({ timeZone: "Not/AZone", nowMs }).ok).toBe(false);
  expect(resolveHourlyBounds({ resolution: "hour" }).ok).toBe(false);
  expect(
    resolveHourlyBounds({
      resolution: "hour",
      sinceTime: "2026-11-28T00:00:00.000Z",
      untilTime: "2026-11-29T01:00:00.000Z",
    }).ok,
  ).toBe(false);
});

it("reports limit windows and reset counts without account secrets", () => {
  const report = decodeLimits(
    compactUsageLimits({
      readAt: "2026-11-28T00:00:00.000Z",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
          usageLimits: {
            checkedAt: "2026-11-28T00:00:00.000Z",
            credentialFingerprint: "fp-secret",
            windows: [
              {
                id: "primary",
                kind: "session",
                label: "5-hour",
                usedPercent: 42,
                resetsAt: "2026-11-28T05:00:00.000Z",
              },
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 80,
                resetsAt: "2026-12-01T00:00:00.000Z",
              },
            ],
            resetCredits: {
              availableCount: 2,
              nextExpiresAt: "2026-12-01T00:00:00.000Z",
              nextCreditId: "credit-secret",
            },
          },
        },
      ],
      sources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "hub.example",
          checkedAt: "2026-11-28T00:00:00.000Z",
          accounts: [
            {
              id: "acct",
              driver: ProviderDriverKind.make("claude"),
              email: "secret@example.com",
              plan: "Pro",
              usageLimits: {
                checkedAt: "2026-11-28T00:00:00.000Z",
                windows: [{ id: "week", kind: "weekly", label: "Week", usedPercent: 10 }],
              },
            },
          ],
        },
      ],
    }),
  );

  expect(
    report.accounts.map((account) => [account.sourceKind, account.label, account.plan]),
  ).toEqual([
    ["hub", "Pro", "Pro"],
    ["provider", "Codex", undefined],
  ]);
  expect(report.accounts[1]?.windows.map((window) => window.kind)).toEqual(["session", "weekly"]);
  expect(report.accounts[1]?.windows[0]).toMatchObject({ usedPercent: 42, remainingPercent: 58 });
  expect(report.accounts[1]?.resetCredits).toEqual({
    availableCount: 2,
    nextExpiresAt: "2026-12-01T00:00:00.000Z",
  });
  const encoded = JSON.stringify(report);
  expect(encoded).not.toContain("secret@example.com");
  expect(encoded).not.toContain("fp-secret");
  expect(encoded).not.toContain("credit-secret");
});
