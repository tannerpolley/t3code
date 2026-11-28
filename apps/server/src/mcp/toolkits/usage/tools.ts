import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  UsageDay,
  UsageModelFilter,
  UsageResolution,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as UsageAnalytics from "../../../usage/UsageAnalytics.ts";
import {
  UsageLimitsReport,
  UsageSummaryReport,
  UsageThreadsReport,
} from "../../../usage/usageReport.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, UsageAnalytics.UsageAnalytics],
};

const windowParameters = {
  environmentId: OrchestratorMcpEnvironmentTarget,
  sinceDay: Schema.optional(UsageDay),
  untilDay: Schema.optional(UsageDay),
  timeZone: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(100)).annotate({
      description: "IANA time zone for day boundaries. Defaults to UTC.",
    }),
  ),
};

const outsideRead = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromThreads) as T;

const UsageSummaryTool = outsideRead(
  Tool.make("t3_usage_summary", {
    ...shared,
    description:
      "Read token, cache, and estimated cost totals by provider, model, and day. Read-only. At most 31 days; omit both dates for the last 7. Uses the usage cache and does not query the thread database. Not the subscription bill.",
    parameters: Schema.Struct({
      ...windowParameters,
      resolution: Schema.optional(UsageResolution),
      sinceTime: Schema.optional(TrimmedNonEmptyString),
      untilTime: Schema.optional(TrimmedNonEmptyString),
      modelFilter: Schema.optional(UsageModelFilter),
    }),
    success: UsageSummaryReport,
  }),
);

const UsageThreadsTool = outsideRead(
  Tool.make("t3_usage_threads", {
    ...shared,
    description:
      "Read the projects and threads that used the most recorded tokens, and threads near automatic compaction. Read-only. No message text. Considers the 200 newest active threads updated in the window.",
    parameters: Schema.Struct({
      ...windowParameters,
      projectId: Schema.optional(ProjectId),
      threadId: Schema.optional(ThreadId),
      limit: Schema.optional(clampedPositiveInt(50)),
    }),
    success: UsageThreadsReport,
  }),
);

const UsageLimitsTool = outsideRead(
  Tool.make("t3_usage_limits", {
    ...shared,
    description:
      "Read cached subscription limit windows, reset times, and banked reset-credit counts. Read-only. Does not probe providers or redeem credits. Omits emails, credentials, and credit ids.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: UsageLimitsReport,
  }),
);

export const UsageToolkit = Toolkit.make(UsageSummaryTool, UsageThreadsTool, UsageLimitsTool);
