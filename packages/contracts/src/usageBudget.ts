import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ScheduledTaskId, ThreadId } from "./baseSchemas.ts";

export const UsageBudgetProvider = Schema.Literals(["claude", "codex"]);
export type UsageBudgetProvider = typeof UsageBudgetProvider.Type;

const UsageBudgetTotals = Schema.Struct({
  turns: NonNegativeInt,
  measuredTurns: NonNegativeInt,
  partialTurns: NonNegativeInt,
  input: NonNegativeInt,
  output: NonNegativeInt,
  uncachedInput: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  uncachedInputTurns: NonNegativeInt,
  cacheReadTurns: NonNegativeInt,
  cacheWriteTurns: NonNegativeInt,
  requests: NonNegativeInt,
  requestCountTurns: NonNegativeInt,
  firstContext: Schema.NullOr(NonNegativeInt),
  peakContext: Schema.NullOr(NonNegativeInt),
  wakes: NonNegativeInt,
  deliveredResults: NonNegativeInt,
  residual: NonNegativeInt,
  residualTurns: NonNegativeInt,
});
export type UsageBudgetTotals = typeof UsageBudgetTotals.Type;

const UsageBudgetRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  issueUrl: Schema.optional(Schema.String),
  threadId: Schema.optional(ThreadId),
  totals: UsageBudgetTotals,
});
export type UsageBudgetRow = typeof UsageBudgetRow.Type;

const UsageBudgetGroups = Schema.Struct({
  task: Schema.Array(UsageBudgetRow),
  role: Schema.Array(UsageBudgetRow),
  stage: Schema.Array(UsageBudgetRow),
  wake: Schema.Array(UsageBudgetRow),
});
export type UsageBudgetGroup = keyof typeof UsageBudgetGroups.Type;

export const UsageBudgetSummary = Schema.Struct({
  since: IsoDateTime,
  asOf: IsoDateTime,
  providers: Schema.Array(
    Schema.Struct({
      provider: UsageBudgetProvider,
      totals: UsageBudgetTotals,
      groups: UsageBudgetGroups,
    }),
  ),
});
export type UsageBudgetSummary = typeof UsageBudgetSummary.Type;

export const ScheduledUsageBudgetReport = Schema.Struct({
  occurrenceAt: IsoDateTime,
  recordedAt: IsoDateTime,
  text: Schema.String,
});
export type ScheduledUsageBudgetReport = typeof ScheduledUsageBudgetReport.Type;

export const ScheduledUsageBudgetReportInput = Schema.Struct({ taskId: ScheduledTaskId });
