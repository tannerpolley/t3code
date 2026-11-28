import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
  UsageProviderKind,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import { UsageLimitsResult, UsageSummaryResult } from "./compact.ts";
import { UsageThreadsResult } from "./readThreads.ts";

const Days = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 }));

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    UsageService.UsageService,
    UsageLimitSources.UsageLimitSources,
    ProviderRegistry.ProviderRegistry,
    SqlClient.SqlClient,
  ],
};

const UsageSummaryTool = Tool.make("t3_usage_summary", {
  ...shared,
  description:
    "Read saved token, cache, and cost totals. Read-only; Read only access is enough. Days 1-90, default 7, in an IANA time zone (default UTC). Breakdown by provider, model, and day. Uses the saved Usage scan and does not scan history or the turn database. not_cached means open Usage for that range, then call again. No prompts, secrets, or paths. Cost is an estimate, not the bill. Reasoning is included in output.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    days: Schema.optional(Days).annotate({ description: "1-90. Default 7." }),
    timeZone: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotate({
      description: "IANA zone. Default UTC.",
    }),
    provider: Schema.optional(UsageProviderKind),
    model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
      description: "Exact model id.",
    }),
    topModels: Schema.optional(clampedPositiveInt(20)).annotate({
      description: "Default 12, max 20.",
    }),
  }),
  success: UsageSummaryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const UsageThreadsTool = Tool.make("t3_usage_threads", {
  ...shared,
  description:
    "Rank recent threads and projects by tokens, and list threads near automatic compaction. Read-only. Looks at the 40 most recently updated threads, 4 provider threads each, and the latest 8 turns. Not a complete history; use t3_usage_summary for period totals. Turn input includes cache reads and writes. No message text.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    days: Schema.optional(Days).annotate({ description: "1-90. Default 7." }),
    timeZone: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotate({
      description: "IANA zone. Default UTC.",
    }),
    projectId: Schema.optional(ProjectId),
    limit: Schema.optional(clampedPositiveInt(30)).annotate({
      description: "Threads and projects to return. Default 15, max 30.",
    }),
  }),
  success: UsageThreadsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const UsageLimitsTool = Tool.make("t3_usage_limits", {
  ...shared,
  description:
    "Read the latest subscription-limit snapshot: window fullness, reset times, and banked reset-credit counts. Read-only. Does not refresh limits or redeem credits. No emails, tokens, or credential ids.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: UsageLimitsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const UsageToolkit = Toolkit.make(UsageSummaryTool, UsageThreadsTool, UsageLimitsTool);
