import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { compactUsageLimits, compactUsageSummary } from "./compact.ts";
import { readThreadUsage } from "./readThreads.ts";
import { UsageToolkit } from "./tools.ts";
import { usageWindow, zonedDayStartIso } from "./window.ts";

const NOT_CACHED =
  "This window is not in the saved Usage scan. Open Usage in T3 Code for that range so the scan is saved, then call again. This tool does not start a scan.";
const NOT_READY =
  "The saved Usage scan was not ready in time. Call again. This tool does not start a scan.";

const windowFor = Effect.fn("UsageMcp.windowFor")(function* (
  days: number | undefined,
  timeZone: string | undefined,
) {
  const now = DateTime.toDateUtc(yield* DateTime.now);
  return yield* Effect.try({
    try: () => usageWindow(days ?? 7, now, timeZone ?? "UTC"),
    catch: () =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "timeZone must be an IANA name, such as UTC or America/New_York.",
      }),
  });
});

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_summary: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const window = yield* windowFor(params.days, params.timeZone);
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage
        .readCachedSummary({
          sinceDay: window.sinceDay,
          untilDay: window.untilDay,
          timeZone: window.timeZone,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.succeed("timeout" as const),
          }),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Usage could not be read.",
              }),
          ),
        );
      if (summary === "timeout")
        return { status: "not_cached" as const, window, message: NOT_READY };
      if (summary === undefined) {
        return { status: "not_cached" as const, window, message: NOT_CACHED };
      }
      return compactUsageSummary({
        summary,
        window,
        topModels: params.topModels ?? 12,
        ...(params.provider === undefined ? {} : { provider: params.provider }),
        ...(params.model === undefined ? {} : { model: params.model }),
      });
    }),
  ),
  t3_usage_threads: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const window = yield* windowFor(params.days, params.timeZone);
      return yield* readThreadUsage({
        sinceIso: zonedDayStartIso(window.sinceDay, window.timeZone),
        window,
        limit: params.limit ?? 15,
        ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Reading thread usage took too long and was stopped.",
              }),
            ),
        }),
        Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) }),
      );
    }),
  ),
  t3_usage_limits: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
      const sources = yield* (yield* UsageLimitSources.UsageLimitSources).current;
      return compactUsageLimits({ providers, sources });
    }),
  ),
});
