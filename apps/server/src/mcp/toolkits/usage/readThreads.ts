import { type ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { roundTo, type UsageWindow } from "./window.ts";

/** Bounds stay on the usage and ordinal indexes. An unbounded turn read has stalled the writer. */
const THREAD_CANDIDATES = 40;
const PROVIDER_THREADS_PER_THREAD = 4;
const TURNS_PER_PROVIDER_THREAD = 8;
const NEAR_AUTO_COMPACT_RATIO = 0.8;
const NEAR_CONTEXT_MAX_RATIO = 0.85;
const TITLE_CHARS = 160;

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const TurnTokens = Schema.Struct({
  input: Schema.Int,
  cachedInput: Schema.Int,
  cacheWrite: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  total: Schema.Int,
});

const ContextUsage = Schema.Struct({
  usedTokens: Schema.Int,
  maxTokens: Schema.NullOr(Schema.Int),
  autoCompactThreshold: Schema.NullOr(Schema.Int),
  fillRatio: Schema.NullOr(Schema.Number),
  nearAutoCompaction: Schema.Boolean,
  basis: Schema.Literals(["autoCompact", "max", "unknown"]),
  model: Schema.NullOr(Schema.String),
  serviceTier: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});

const ThreadUsage = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  tokens: TurnTokens,
  cacheHitRate: Schema.NullOr(Schema.Number),
  turnsCounted: Schema.Int,
  partialTurns: Schema.Int,
  models: Schema.Array(Schema.String),
  context: Schema.NullOr(ContextUsage),
});

export const UsageThreadsResult = Schema.Struct({
  window: Schema.Struct({
    sinceDay: Schema.String,
    untilDay: Schema.String,
    timeZone: Schema.String,
    days: Schema.Int,
  }),
  since: Schema.String,
  threadsConsidered: Schema.Int,
  bounds: Schema.Struct({
    threads: Schema.Int,
    providerThreadsPerThread: Schema.Int,
    turnsPerProviderThread: Schema.Int,
  }),
  note: Schema.String,
  threads: Schema.Array(ThreadUsage),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.NullOr(Schema.String),
      threads: Schema.Int,
      tokens: Schema.Int,
    }),
  ),
  nearCompaction: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      projectTitle: Schema.NullOr(Schema.String),
      fillRatio: Schema.Number,
      usedTokens: Schema.Int,
      autoCompactThreshold: Schema.NullOr(Schema.Int),
      maxTokens: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type UsageThreadsResult = typeof UsageThreadsResult.Type;

const NOTE =
  "Totals sum the latest 8 completed turns of up to 4 provider threads on the 40 most recently updated threads in the window. Older turns are not read. Turn input includes cache reads and writes; reasoning is included in output. Context is the latest window on the active provider thread, and nearAutoCompaction means at least 80% of the automatic-compaction point, or 85% of the max window when no compaction point is reported. Use t3_usage_summary for complete period totals.";

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly active_provider_thread_id: string | null;
  readonly updated_at: string;
}

interface ProviderThreadRow {
  readonly provider_thread_id: string;
}

interface UsageRow {
  readonly used_tokens: number | null;
  readonly max_tokens: number | null;
  readonly auto_compact_threshold: number | null;
  readonly usage_updated_at: string | null;
  readonly model: string | null;
  readonly service_tier: string | null;
}

interface TurnRow {
  readonly completed_at: string | null;
  readonly model: string | null;
  readonly usage_status: string | null;
  readonly local_command: number | boolean | null;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_creation_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

function count(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function whole(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function text(value: string | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shortTitle(value: string): string {
  const chars = Array.from(value);
  return chars.length <= TITLE_CHARS ? value : chars.slice(0, TITLE_CHARS).join("");
}

function contextOf(row: UsageRow): UsageThreadsResult["threads"][number]["context"] {
  const used = whole(row.used_tokens);
  if (used === null) return null;
  const max = whole(row.max_tokens);
  const compact = whole(row.auto_compact_threshold);
  const compactOk = compact !== null && compact > 0;
  const maxOk = max !== null && max > 0;
  const basis = compactOk ? "autoCompact" : maxOk ? "max" : "unknown";
  const denominator = compactOk ? compact : maxOk ? max : null;
  const fillRatio = denominator === null ? null : roundTo(used / denominator, 4);
  const nearAutoCompaction = compactOk
    ? used / compact >= NEAR_AUTO_COMPACT_RATIO
    : maxOk
      ? used / max >= NEAR_CONTEXT_MAX_RATIO
      : false;
  return {
    usedTokens: used,
    maxTokens: maxOk ? max : null,
    autoCompactThreshold: compactOk ? compact : null,
    fillRatio,
    nearAutoCompaction,
    basis,
    model: text(row.model),
    serviceTier: text(row.service_tier),
    updatedAt: text(row.usage_updated_at),
  };
}

export const readThreadUsage = Effect.fn("UsageMcp.readThreadUsage")(function* (input: {
  readonly sinceIso: string;
  readonly window: UsageWindow;
  readonly limit: number;
  readonly projectId?: ProjectId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.gen(function* () {
    const candidates = yield* sql<ThreadRow>`
      SELECT thread_id, project_id, title, active_provider_thread_id, updated_at
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND updated_at >= ${input.sinceIso}
        ${input.projectId === undefined ? sql`` : sql`AND project_id = ${input.projectId}`}
      ORDER BY updated_at DESC
      LIMIT ${THREAD_CANDIDATES}
    `;
    const projectIds = [...new Set(candidates.map((row) => row.project_id))];
    const projectRows =
      projectIds.length === 0
        ? []
        : yield* sql<{ readonly project_id: string; readonly title: string }>`
            SELECT project_id, title
            FROM projection_projects
            WHERE project_id IN (SELECT value FROM json_each(${encodeIds(projectIds)}))
          `;
    const projectTitles = new Map(projectRows.map((row) => [row.project_id, row.title]));
    const threads: Array<UsageThreadsResult["threads"][number]> = [];
    for (const candidate of candidates) {
      const providerRows = yield* sql<ProviderThreadRow>`
        SELECT provider_thread_id
        FROM orchestration_v2_projection_provider_threads
          INDEXED BY orchestration_v2_projection_provider_threads_thread_idx
        WHERE thread_id = ${candidate.thread_id}
        ORDER BY updated_at DESC
        LIMIT ${PROVIDER_THREADS_PER_THREAD}
      `;
      const providerThreadIds: string[] = [];
      if (candidate.active_provider_thread_id !== null) {
        providerThreadIds.push(candidate.active_provider_thread_id);
      }
      for (const row of providerRows) {
        if (!providerThreadIds.includes(row.provider_thread_id)) {
          providerThreadIds.push(row.provider_thread_id);
        }
      }
      const selected = providerThreadIds.slice(0, PROVIDER_THREADS_PER_THREAD);
      const usageRows =
        candidate.active_provider_thread_id === null
          ? []
          : yield* sql<UsageRow>`
              SELECT
                json_extract(payload_json, '$.tokenUsage.usedTokens') AS used_tokens,
                json_extract(payload_json, '$.tokenUsage.maxTokens') AS max_tokens,
                json_extract(payload_json, '$.tokenUsage.autoCompactThreshold') AS auto_compact_threshold,
                json_extract(payload_json, '$.tokenUsage.updatedAt') AS usage_updated_at,
                json_extract(payload_json, '$.model') AS model,
                json_extract(payload_json, '$.serviceTier') AS service_tier
              FROM orchestration_v2_projection_provider_turns
                INDEXED BY orchestration_v2_projection_provider_turns_usage_idx
              WHERE provider_thread_id = ${candidate.active_provider_thread_id}
                AND json_type(payload_json, '$.tokenUsage') = 'object'
              ORDER BY julianday(json_extract(payload_json, '$.tokenUsage.updatedAt')) DESC,
                ordinal DESC
              LIMIT 1
            `;
      let inputTokens = 0;
      let cachedInput = 0;
      let cacheWrite = 0;
      let output = 0;
      let reasoning = 0;
      let turnsCounted = 0;
      let partialTurns = 0;
      const models: string[] = [];
      for (const providerThreadId of selected) {
        const turns = yield* sql<TurnRow>`
          SELECT
            completed_at,
            json_extract(payload_json, '$.model') AS model,
            json_extract(payload_json, '$.turnTokenUsage.usageStatus') AS usage_status,
            json_extract(payload_json, '$.turnTokenUsage.localCommand') AS local_command,
            json_extract(payload_json, '$.turnTokenUsage.inputTokens') AS input_tokens,
            json_extract(payload_json, '$.turnTokenUsage.cachedInputTokens') AS cached_input_tokens,
            json_extract(payload_json, '$.turnTokenUsage.cacheCreationTokens') AS cache_creation_tokens,
            json_extract(payload_json, '$.turnTokenUsage.outputTokens') AS output_tokens,
            json_extract(payload_json, '$.turnTokenUsage.reasoningTokens') AS reasoning_tokens
          FROM orchestration_v2_projection_provider_turns
            INDEXED BY orchestration_v2_projection_provider_turns_thread_ordinal_idx
          WHERE provider_thread_id = ${providerThreadId}
          ORDER BY ordinal DESC
          LIMIT ${TURNS_PER_PROVIDER_THREAD}
        `;
        for (const turn of turns) {
          if (turn.completed_at === null || turn.completed_at < input.sinceIso) continue;
          if (turn.local_command === 1 || turn.local_command === true) continue;
          if (
            turn.usage_status === null &&
            turn.input_tokens === null &&
            turn.output_tokens === null
          ) {
            continue;
          }
          inputTokens += count(turn.input_tokens);
          cachedInput += count(turn.cached_input_tokens);
          cacheWrite += count(turn.cache_creation_tokens);
          output += count(turn.output_tokens);
          reasoning += count(turn.reasoning_tokens);
          turnsCounted += 1;
          if (turn.usage_status === "partial" || turn.usage_status === "unavailable") {
            partialTurns += 1;
          }
          const model = text(turn.model);
          if (model !== null && !models.includes(model) && models.length < 4) models.push(model);
        }
      }
      const context = usageRows[0] === undefined ? null : contextOf(usageRows[0]);
      if (context === null && turnsCounted === 0) continue;
      const total = Math.round(inputTokens + output);
      const projectTitle = projectTitles.get(candidate.project_id) ?? null;
      threads.push({
        threadId: candidate.thread_id,
        title: shortTitle(candidate.title),
        projectId: candidate.project_id,
        projectTitle: projectTitle === null ? null : shortTitle(projectTitle),
        updatedAt: candidate.updated_at,
        tokens: {
          input: Math.round(inputTokens),
          cachedInput: Math.round(cachedInput),
          cacheWrite: Math.round(cacheWrite),
          output: Math.round(output),
          reasoning: Math.round(reasoning),
          total,
        },
        cacheHitRate:
          inputTokens > 0 && cachedInput <= inputTokens
            ? roundTo(cachedInput / inputTokens, 4)
            : null,
        turnsCounted,
        partialTurns,
        models,
        context,
      });
    }
    threads.sort(
      (left, right) =>
        right.tokens.total - left.tokens.total ||
        (right.context?.fillRatio ?? 0) - (left.context?.fillRatio ?? 0) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
    const ranked = threads.slice(0, input.limit);
    const projects = new Map<string, { title: string | null; threads: number; tokens: number }>();
    for (const thread of threads) {
      const project = projects.get(thread.projectId) ?? {
        title: thread.projectTitle,
        threads: 0,
        tokens: 0,
      };
      project.threads += 1;
      project.tokens += thread.tokens.total;
      projects.set(thread.projectId, project);
    }
    const nearCompaction = threads
      .flatMap((thread) => {
        const context = thread.context;
        if (context === null || !context.nearAutoCompaction || context.fillRatio === null)
          return [];
        return [
          {
            threadId: thread.threadId,
            title: thread.title,
            projectTitle: thread.projectTitle,
            fillRatio: context.fillRatio,
            usedTokens: context.usedTokens,
            autoCompactThreshold: context.autoCompactThreshold,
            maxTokens: context.maxTokens,
          },
        ];
      })
      .sort((left, right) => right.fillRatio - left.fillRatio)
      .slice(0, input.limit);
    return {
      window: input.window,
      since: input.sinceIso,
      threadsConsidered: candidates.length,
      bounds: {
        threads: THREAD_CANDIDATES,
        providerThreadsPerThread: PROVIDER_THREADS_PER_THREAD,
        turnsPerProviderThread: TURNS_PER_PROVIDER_THREAD,
      },
      note: NOTE,
      threads: ranked,
      projects: [...projects.entries()]
        .map(([projectId, project]) => ({ projectId, ...project }))
        .sort(
          (left, right) =>
            right.tokens - left.tokens || left.projectId.localeCompare(right.projectId),
        )
        .slice(0, input.limit),
      nearCompaction,
    } satisfies UsageThreadsResult;
  });
  return yield* NodeSqliteClient.readOnly(read);
});
