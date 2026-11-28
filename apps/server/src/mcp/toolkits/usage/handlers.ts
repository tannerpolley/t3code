import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as UsageAnalytics from "../../../usage/UsageAnalytics.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { UsageToolkit } from "./tools.ts";

const failure = (error: UsageAnalytics.UsageAnalyticsError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "invalidWindow" ? "invalid_request" : "orchestration_error",
    message: error.detail,
  });

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_summary: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const usage = yield* UsageAnalytics.UsageAnalytics;
      return yield* usage.readSummary(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_usage_threads: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const usage = yield* UsageAnalytics.UsageAnalytics;
      return yield* usage.readThreads(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_usage_limits: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const usage = yield* UsageAnalytics.UsageAnalytics;
      return yield* usage.readLimits();
    }),
  ),
});
