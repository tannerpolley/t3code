import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Tool } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as UsageAnalytics from "../../../usage/UsageAnalytics.ts";
import { compactUsageLimits } from "../../../usage/usageReport.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as UsageHandlers from "./handlers.ts";
import { UsageToolkit } from "./tools.ts";

const limits = compactUsageLimits({
  readAt: "2026-11-28T00:00:00.000Z",
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      usageLimits: {
        checkedAt: "2026-11-28T00:00:00.000Z",
        windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 42 }],
        resetCredits: { availableCount: 1, nextCreditId: "credit-secret" },
      },
    },
  ],
  sources: [],
});

const readOnly = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("environment-usage"),
  requestNamespace: "usage-test",
  thread: undefined,
  client: { sessionId: "session", label: "Token Optimizer", access: "read-only" },
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 0,
});

it("hides usage tools from threads and marks them read-only", () => {
  for (const tool of Object.values(UsageToolkit.tools)) {
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  }
});

it.effect("lets a read-only outside client read limits", () =>
  Effect.gen(function* () {
    const toolkit = yield* UsageToolkit;
    const collected = yield* toolkit
      .handle("t3_usage_limits", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(collected.at(-1)?.result).toMatchObject({
      accounts: [{ label: "Codex", windows: [{ remainingPercent: 58 }] }],
    });
    expect(JSON.stringify(collected)).not.toContain("credit-secret");
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(UsageHandlers.layer).pipe(
        Layer.provideMerge(readOnly),
        Layer.provideMerge(
          Layer.mock(UsageAnalytics.UsageAnalytics)({
            readLimits: () => Effect.succeed(limits),
          }),
        ),
      ),
    ),
  ),
);
