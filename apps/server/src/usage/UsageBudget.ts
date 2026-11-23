import {
  EnvironmentId,
  IssueTrackerKind,
  threadIssueKeyOf,
  type ThreadIssueLink,
  type ThreadLinkedIssue,
  type IsoDateTime,
  ScheduledUsageBudgetReport,
  type ScheduledTaskId,
  THREAD_ROLE_LABELS,
  ThreadId,
  UsageReadError,
  resolveThreadRole,
  type TurnTokenUsage,
  type UsageBudgetGroup,
  type UsageBudgetProvider,
  type UsageBudgetRow,
  type UsageBudgetSummary,
  type UsageBudgetTotals,
} from "@t3tools/contracts";
import { collectLimitAccounts, paceOf, remainingPercent } from "@t3tools/shared/usageLimits";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as SqlClient from "effect/sql/SqlClient";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP = 10;

export class UsageBudget extends Context.Service<
  UsageBudget,
  {
    readonly latestReport: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<ScheduledUsageBudgetReport | null, UsageReadError>;
    readonly report: (
      occurrenceAt: IsoDateTime,
    ) => Effect.Effect<ScheduledUsageBudgetReport, UsageReadError>;
    readonly read: (asOf?: IsoDateTime) => Effect.Effect<UsageBudgetSummary, UsageReadError>;
  }
>()("t3/usage/UsageBudget") {}

interface TurnRow {
  readonly driver: "claudeAgent" | "codex";
  readonly status: string;
  readonly usage: string | null;
  readonly native_child: number;
  readonly thread_id: string;
  readonly title: string | null;
  readonly role: string | null;
  readonly stage: string | null;
  readonly managed_issue: string | null;
  readonly explicit_issue: string | null;
  readonly scheduled_task_id: string | null;
  readonly scheduled_task_title: string | null;
  readonly run_id: string | null;
  readonly attempt_reason: string | null;
  readonly continuation: string | null;
  readonly source: string | null;
  readonly wake_reason: string | null;
  readonly contains_failure: number | null;
  readonly quiet_nudge: number | null;
  readonly pull_request_wake: number | null;
  readonly actor: string | null;
  readonly linked_sender: string | null;
  readonly batched: number | null;
  readonly batch_size: number | null;
}

function emptyTotals() {
  return {
    turns: 0,
    measuredTurns: 0,
    partialTurns: 0,
    input: 0,
    output: 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    uncachedInputTurns: 0,
    cacheReadTurns: 0,
    cacheWriteTurns: 0,
    requests: 0,
    requestCountTurns: 0,
    firstContext: null as number | null,
    peakContext: null as number | null,
    wakes: 0,
    deliveredResults: 0,
    residual: 0,
    residualTurns: 0,
  } satisfies UsageBudgetTotals;
}

type Bucket = {
  totals: ReturnType<typeof emptyTotals>;
  wakeRuns: Set<string>;
};

function addTurn(bucket: Bucket, row: TurnRow, usage: TurnTokenUsage | undefined) {
  const totals = bucket.totals;
  totals.turns++;
  if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) totals.measuredTurns++;
  if (
    row.status !== "completed" ||
    usage?.usageStatus !== "complete" ||
    usage.requestCount === undefined ||
    usage.firstInputContext === undefined ||
    usage.peakInputContext === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheCreationTokens === undefined ||
    usage.hasSubagents ||
    (usage.otherUsage !== undefined &&
      (usage.otherUsage.inputTokens > 0 || usage.otherUsage.outputTokens > 0))
  )
    totals.partialTurns++;
  totals.input += usage?.inputTokens ?? 0;
  totals.output += usage?.outputTokens ?? 0;
  if (usage?.cachedInputTokens !== undefined) {
    totals.cacheRead += usage.cachedInputTokens;
    totals.cacheReadTurns++;
  }
  if (usage?.cacheCreationTokens !== undefined) {
    totals.cacheWrite += usage.cacheCreationTokens;
    totals.cacheWriteTurns++;
  }
  if (usage?.uncachedInputTokens !== undefined) {
    totals.uncachedInput += usage.uncachedInputTokens;
    totals.uncachedInputTurns++;
  } else if (
    usage?.inputTokens !== undefined &&
    usage.cachedInputTokens !== undefined &&
    usage.cacheCreationTokens !== undefined &&
    usage.inputTokens >= usage.cachedInputTokens + usage.cacheCreationTokens
  ) {
    totals.uncachedInput += usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationTokens;
    totals.uncachedInputTurns++;
  }
  if (usage?.requestCount !== undefined) {
    totals.requests += usage.requestCount;
    totals.requestCountTurns++;
  }
  if (usage?.firstInputContext !== undefined) totals.firstContext ??= usage.firstInputContext;
  if (usage?.peakInputContext !== undefined) {
    totals.peakContext = Math.max(totals.peakContext ?? 0, usage.peakInputContext);
  }
  if (usage?.otherUsage !== undefined) {
    totals.residual += usage.otherUsage.inputTokens + usage.otherUsage.outputTokens;
    totals.residualTurns++;
  }
  if (
    row.run_id !== null &&
    row.native_child === 0 &&
    (row.attempt_reason === null || row.attempt_reason === "initial") &&
    !bucket.wakeRuns.has(row.run_id)
  ) {
    bucket.wakeRuns.add(row.run_id);
    totals.wakes++;
    totals.deliveredResults += row.batch_size ?? 0;
  }
}

function wakeReason(row: TurnRow): string {
  if (row.native_child !== 0) return "Native child";
  if (row.attempt_reason !== null && row.attempt_reason !== "initial") return "Retry";
  switch (row.wake_reason) {
    case "provider_retry":
      return "Provider retry";
    case "child_question":
      return "Child question";
    case "child_approval":
      return "Child approval";
    case "owner_decision":
      return "Owner decision";
  }
  if (row.continuation !== null) return row.continuation;
  if (row.batch_size !== null) {
    if (row.contains_failure === 1) return "Child failure";
    if (row.batched === 1) return "Batched child results";
    return row.batch_size > 1 ? "Combined child results" : "Child result";
  }
  if (row.quiet_nudge === 1) return "Nudge";
  if (row.pull_request_wake === 1) return "Pull request monitor";
  switch (row.source) {
    case "delegated_task":
      return "Child result";
    case "background_task":
    case "background_command":
    case "command":
    case "subagent":
      return "Background completion";
    case "monitor":
      return "Monitor";
    case "system":
      return "System";
  }
  if (row.scheduled_task_id !== null) return "Scheduled task";
  if (row.actor === "user") return "User";
  if (row.linked_sender !== null) return "Agent message";
  return "Unspecified";
}

type RowLabel = Omit<UsageBudgetRow, "totals">;

function taskLabel(row: TurnRow): RowLabel {
  if (row.managed_issue !== null) {
    const issue = JSON.parse(row.managed_issue) as ThreadLinkedIssue;
    return {
      key: threadIssueKeyOf({
        tracker: IssueTrackerKind.make("github"),
        host: issue.host,
        scope: issue.repository,
        key: String(issue.number),
      }),
      label: `${issue.repository} #${issue.number} ${issue.title}`.trim(),
      issueUrl: issue.url,
    };
  }
  if (row.explicit_issue !== null) {
    const issue = JSON.parse(row.explicit_issue) as ThreadIssueLink;
    return {
      key: threadIssueKeyOf(issue),
      label: `${issue.scope} ${issue.displayKey} ${issue.title}`.trim(),
      issueUrl: issue.url,
    };
  }
  if (row.scheduled_task_id !== null) {
    return {
      key: `schedule:${row.scheduled_task_id}`,
      label: row.scheduled_task_title ?? row.title ?? row.scheduled_task_id,
    };
  }
  return {
    key: `thread:${row.thread_id}`,
    label: row.title ?? row.thread_id,
    ...(row.title === null ? {} : { threadId: ThreadId.make(row.thread_id) }),
  };
}

function summarize(provider: UsageBudgetProvider, rows: ReadonlyArray<TurnRow>) {
  const total: Bucket = { totals: emptyTotals(), wakeRuns: new Set() };
  const groups: Record<UsageBudgetGroup, Map<string, RowLabel & Bucket>> = {
    task: new Map(),
    role: new Map(),
    stage: new Map(),
    wake: new Map(),
  };
  const addGroup = (
    group: UsageBudgetGroup,
    label: RowLabel,
    row: TurnRow,
    usage?: TurnTokenUsage,
  ) => {
    let bucket = groups[group].get(label.key);
    if (bucket === undefined) {
      bucket = { ...label, totals: emptyTotals(), wakeRuns: new Set() };
      groups[group].set(label.key, bucket);
    }
    addTurn(bucket, row, usage);
  };
  for (const row of rows) {
    if ((row.driver === "claudeAgent" ? "claude" : "codex") !== provider) continue;
    const usage = row.usage === null ? undefined : (JSON.parse(row.usage) as TurnTokenUsage);
    if (usage?.localCommand === true) continue;
    const role = row.role === null ? undefined : resolveThreadRole(row.role);
    const roleLabel =
      row.native_child !== 0
        ? "Native child"
        : role === undefined
          ? "Unspecified"
          : THREAD_ROLE_LABELS[role];
    const stage = row.stage ?? "Unspecified";
    const wake = wakeReason(row);
    addTurn(total, row, usage);
    addGroup("task", taskLabel(row), row, usage);
    addGroup("role", { key: roleLabel, label: roleLabel }, row, usage);
    addGroup("stage", { key: stage, label: stage }, row, usage);
    addGroup("wake", { key: wake, label: wake }, row, usage);
  }
  const top = (group: UsageBudgetGroup) =>
    [...groups[group].values()]
      .sort(
        (a, b) =>
          b.totals.input + b.totals.output - (a.totals.input + a.totals.output) ||
          a.key.localeCompare(b.key),
      )
      .slice(0, TOP)
      .map(({ key, label, issueUrl, threadId, totals }) => ({
        key,
        label,
        totals,
        ...(issueUrl === undefined ? {} : { issueUrl }),
        ...(threadId === undefined ? {} : { threadId }),
      }));
  return {
    provider,
    totals: total.totals,
    groups: { task: top("task"), role: top("role"), stage: top("stage"), wake: top("wake") },
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const limitSources = yield* Effect.serviceOption(UsageLimitSources.UsageLimitSources);

  const query = Effect.fn("UsageBudget.query")(function* (asOf: IsoDateTime) {
    const since = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(asOf) - WEEK_MS));
    const rows = yield* sql<TurnRow>`
      SELECT pt.driver, t.status, t.thread_id,
        json_extract(t.payload_json, '$.turnTokenUsage') AS usage,
        (t.run_attempt_id IS NULL AND pt.owner_node_id IS NOT NULL) AS native_child,
        CASE WHEN th.deleted_at IS NULL THEN th.title END AS title,
        CASE WHEN json_type(r.payload_json, '$.usageAttribution') IS NOT NULL
          THEN json_extract(r.payload_json, '$.usageAttribution.role')
          ELSE json_extract(th.payload_json, '$.role') END AS role,
        json_extract(r.payload_json, '$.usageAttribution.stage') AS stage,
        CASE WHEN json_type(r.payload_json, '$.usageAttribution') IS NOT NULL
          THEN json_extract(r.payload_json, '$.usageAttribution.linkedIssue')
          ELSE json_extract(th.payload_json, '$.linkedIssue') END AS managed_issue,
        CASE WHEN json_type(r.payload_json, '$.usageAttribution') IS NOT NULL
          THEN json_extract(r.payload_json, '$.usageAttribution.issue')
          WHEN json_array_length(th.payload_json, '$.issues') = 1
          THEN json_extract(th.payload_json, '$.issues[0]') END AS explicit_issue,
        json_extract(m.payload_json, '$.scheduledTaskId') AS scheduled_task_id,
        schedule.title AS scheduled_task_title,
        r.run_id,
        json_extract(a.payload_json, '$.reason') AS attempt_reason,
        CASE
          WHEN json_type(r.payload_json, '$.manualContinuationOfRunId') IS NOT NULL THEN 'Manual resume'
          WHEN json_type(r.payload_json, '$.restartContinuationOfRunId') IS NOT NULL THEN 'Restart continuation'
          WHEN json_type(r.payload_json, '$.usageLimitContinuationOfRunId') IS NOT NULL THEN 'Usage limit continuation'
        END AS continuation,
        json_extract(m.payload_json, '$.notification.source.kind') AS source,
        json_extract(m.payload_json, '$.notification.source.wakeReason') AS wake_reason,
        (json_type(m.payload_json, '$.notification.source.quietDelegate') = 'object') AS quiet_nudge,
        (json_type(m.payload_json, '$.notification.source.pullRequest') = 'object') AS pull_request_wake,
        json_extract(m.payload_json, '$.delegatedCompletion.containsFailure') AS contains_failure,
        json_extract(m.payload_json, '$.createdBy') AS actor,
        json_extract(m.payload_json, '$.senderThreadId') AS linked_sender,
        json_extract(m.payload_json, '$.delegatedCompletion.batched') AS batched,
        json_array_length(m.payload_json, '$.delegatedCompletion.taskIds') AS batch_size
      FROM orchestration_v2_projection_provider_turns t INDEXED BY usage_budget_completed_turn_idx
      CROSS JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = t.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
      LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = t.node_id
      LEFT JOIN orchestration_v2_projection_nodes owner ON owner.node_id = pt.owner_node_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = coalesce(a.run_id, n.run_id, owner.run_id)
      LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = t.thread_id
      LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
      LEFT JOIN scheduled_tasks schedule ON schedule.task_id = json_extract(m.payload_json, '$.scheduledTaskId')
      WHERE t.completed_at >= ${since} AND t.completed_at < ${asOf}
        AND t.status IN ('completed', 'interrupted', 'failed', 'cancelled')
        AND pt.driver IN ('claudeAgent', 'codex')
      ORDER BY t.completed_at, t.provider_turn_id
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read recorded turn usage.",
            cause,
          }),
      ),
    );
    return { since, asOf, providers: [summarize("claude", rows), summarize("codex", rows)] };
  });
  const cache = yield* Cache.makeWith(query, {
    capacity: 8,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 second" : 0),
  });
  const read = Effect.fn("UsageBudget.read")(function* (asOf?: IsoDateTime) {
    const now =
      asOf ??
      DateTime.formatIso(
        DateTime.makeUnsafe(Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000),
      );
    return yield* Cache.get(cache, now);
  });
  const decodeReport = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ScheduledUsageBudgetReport),
  );
  const latestReport = Effect.fn("UsageBudget.latestReport")(
    function* (taskId: ScheduledTaskId) {
      const [row] = yield* sql<{ readonly usage_budget_report_json: string | null }>`
      SELECT usage_budget_report_json
      FROM scheduled_tasks
      WHERE task_id = ${taskId} AND action = 'usage_budget'
    `.pipe(NodeSqliteClient.readOnly);
      return row?.usage_budget_report_json == null
        ? null
        : yield* decodeReport(row.usage_budget_report_json);
    },
    Effect.mapError(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Could not read the scheduled usage report.",
          cause,
        }),
    ),
  );
  const report = Effect.fn("UsageBudget.report")(function* (occurrenceAt: IsoDateTime) {
    const summary = yield* read(occurrenceAt);
    const providers = Option.isSome(providerRegistry)
      ? yield* providerRegistry.value.getProviders
      : [];
    const usageLimitSources = Option.isSome(limitSources) ? yield* limitSources.value.current : [];
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("report"),
          {
            entry: { target: { label: "This environment" } },
            serverConfig: { providers, usageLimitSources },
          },
        ],
      ]),
    ).filter((account) => account.driver === "claudeAgent" || account.driver === "codex");
    const checkedAt = yield* DateTime.now;
    const recordedAt = DateTime.formatIso(checkedAt);
    const now = DateTime.toEpochMillis(checkedAt);
    const lines = [
      "Weekly usage budget",
      `${summary.since} to ${summary.asOf} (environment-wide, settled turns)`,
      "",
      "Provider quota snapshots",
    ];
    if (accounts.length === 0) lines.push("No readable provider quota meters.");
    for (const account of accounts) {
      const limits = account.limits;
      const driver = account.driver === "claudeAgent" ? "Claude" : "Codex";
      lines.push(`${driver} ${account.displayName ?? ""} (checked ${limits.checkedAt})`);
      for (const window of limits.windows) {
        const stale = window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now;
        lines.push(
          `  ${window.label}: ${remainingPercent(window)}% left, reset ${window.resetsAt ?? "unknown"}, pace ${paceOf(window, now) ?? "unknown"}${stale ? " (stale)" : ""}`,
        );
      }
      if (limits.credits?.hasCredits) {
        lines.push(
          `  Purchased credits: ${limits.credits.unlimited ? "unlimited" : (limits.credits.balance ?? "unknown")}`,
        );
      }
      if (limits.resetCredits !== undefined)
        lines.push(`  Banked resets: ${limits.resetCredits.availableCount}`);
    }
    const labels = {
      task: "Task",
      role: "Role",
      stage: "Stage",
      wake: "Wake reason",
    } satisfies Record<UsageBudgetGroup, string>;
    for (const { provider, totals, groups } of summary.providers) {
      lines.push(
        "",
        `${provider === "claude" ? "Claude" : "Codex"} recorded usage`,
        `${totals.input + totals.output} tokens, ${totals.measuredTurns}/${totals.turns} turns measured, ${totals.partialTurns} with incomplete detail`,
      );
      if (totals.residual > 0)
        lines.push(
          `${totals.residual} additional provider-ledger tokens may overlap native children and are outside ranked totals.`,
        );
      for (const group of ["task", "role", "stage", "wake"] as const) {
        lines.push(labels[group]);
        for (const row of groups[group]) {
          const { input, output, wakes, deliveredResults } = row.totals;
          lines.push(
            `  ${row.label}: ${input + output} tokens, ${wakes} run starts, ${deliveredResults} child results`,
          );
        }
      }
    }
    return { occurrenceAt, recordedAt, text: lines.join("\n") };
  });
  return UsageBudget.of({ read, report, latestReport });
});

export const layer = Layer.effect(UsageBudget, make);
