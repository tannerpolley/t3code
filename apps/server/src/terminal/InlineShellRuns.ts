import * as NodeUtil from "node:util";
import {
  OrchestrationV2TurnItemJson as TurnItemSchema,
  type InlineShellRunLookupInput,
  EventId,
  InlineShellRunError,
  type InlineShellRunInput,
  type InlineShellRunRecord,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { inlineShellOutputTail } from "@t3tools/shared/inlineShell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { TerminalManager } from "./Manager.ts";

const decodeStoredItem = Schema.decodeEffect(Schema.fromJsonString(TurnItemSchema));
const runItemId = (threadId: InlineShellRunInput["threadId"], runId: string) =>
  TurnItemId.make(`inline-shell:${threadId.length}:${threadId}:${runId}`);

export class InlineShellRuns extends Context.Service<
  InlineShellRuns,
  {
    readonly latest: (
      input: InlineShellRunLookupInput,
    ) => Effect.Effect<InlineShellRunRecord | null, InlineShellRunError>;
    readonly run: (
      input: InlineShellRunInput,
    ) => Effect.Effect<InlineShellRunRecord, InlineShellRunError>;
  }
>()("t3/terminal/InlineShellRuns") {}

export const layer = Layer.effect(
  InlineShellRuns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const terminal = yield* TerminalManager;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const lock = yield* Semaphore.make(1);
    const active = new Map<string, InlineShellRunRecord>();

    const persist = Effect.fn("InlineShellRuns.persist")(function* (record: InlineShellRunRecord) {
      const now = yield* DateTime.now;
      const item: OrchestrationV2TurnItem = {
        id: runItemId(record.threadId, record.runId),
        threadId: record.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status:
          record.status === "running"
            ? "running"
            : record.status === "error"
              ? "failed"
              : record.status === "interrupted"
                ? "interrupted"
                : "completed",
        title: "Inline shell run",
        startedAt: DateTime.makeUnsafe(record.startedAt),
        completedAt: record.completedAt === null ? null : DateTime.makeUnsafe(record.completedAt),
        updatedAt: now,
        type: "system_notice",
        message: "Inline shell run",
        inlineShellRun: record,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(
              `inline-shell:${record.threadId.length}:${record.threadId}:${record.runId}:${record.status}`,
            ),
            type: "turn-item.updated",
            threadId: record.threadId,
            occurredAt: now,
            payload: item,
          },
        ],
      });
    });

    const abandoned = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type = 'system_notice' AND status = 'running' AND json_extract(payload_json, '$.inlineShellRun') IS NOT NULL`.pipe(
      Effect.orDie,
    );
    for (const row of abandoned) {
      const item = yield* decodeStoredItem(row.payload_json).pipe(Effect.orDie);
      if (item.type !== "system_notice" || item.inlineShellRun === undefined) continue;
      const now = yield* DateTime.now;
      yield* persist({
        ...item.inlineShellRun,
        status: "interrupted",
        completedAt: DateTime.formatIso(now),
        durationMs: Math.max(
          0,
          DateTime.toEpochMillis(now) - Date.parse(item.inlineShellRun.startedAt),
        ),
        output: inlineShellOutputTail(
          NodeUtil.stripVTControlCharacters(item.inlineShellRun.output),
        ),
      }).pipe(Effect.orDie);
    }

    const unsubscribe = yield* terminal.subscribe((event) =>
      Effect.gen(function* () {
        const key = `${event.threadId.length}:${event.threadId}${event.terminalId}`;
        const record = active.get(key);
        if (record === undefined) return;
        if (event.type === "output") {
          active.set(key, { ...record, output: inlineShellOutputTail(record.output + event.data) });
          return;
        }
        if (event.type !== "exited" && event.type !== "closed" && event.type !== "error") return;
        const endedAt = yield* DateTime.now;
        const finished: InlineShellRunRecord = {
          ...record,
          status:
            event.type === "error"
              ? "error"
              : event.type === "closed" ||
                  (event.type === "exited" &&
                    ((event.exitSignal !== null && event.exitSignal !== 0) ||
                      event.exitCode === 130))
                ? "interrupted"
                : "completed",
          exitCode: event.type === "exited" ? event.exitCode : null,
          completedAt: DateTime.formatIso(endedAt),
          durationMs: Math.max(0, DateTime.toEpochMillis(endedAt) - Date.parse(record.startedAt)),
          output: inlineShellOutputTail(NodeUtil.stripVTControlCharacters(record.output)),
        };
        yield* persist(finished);
        active.delete(key);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not persist inline shell completion", cause),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run = Effect.fn("InlineShellRuns.run")(function* (input: InlineShellRunInput) {
      const itemId = runItemId(input.threadId, input.runId);
      const existing = yield* projection.getTurnItem({ threadId: input.threadId, itemId });
      if (existing?.type === "system_notice" && existing.inlineShellRun !== undefined)
        return existing.inlineShellRun;
      const thread = yield* projection.getThread(input.threadId);
      if (thread.projectId === null)
        return yield* new InlineShellRunError({ threadId: input.threadId });
      const project = yield* projects.getShell(thread.projectId);
      if (Option.isNone(project))
        return yield* new InlineShellRunError({ threadId: input.threadId });
      const now = yield* DateTime.now;
      const record: InlineShellRunRecord = {
        ...input,
        terminalId: `inline-${input.runId}`,
        status: "running",
        startedAt: DateTime.formatIso(now),
        completedAt: null,
        exitCode: null,
        durationMs: 0,
        output: "",
      };
      // Commit before launch; the subscriber is server-owned and survives client disconnects.
      yield* persist(record);
      const key = `${input.threadId.length}:${input.threadId}${record.terminalId}`;
      active.set(key, record);
      const opened = yield* Effect.result(
        terminal.openCommand({
          threadId: input.threadId,
          terminalId: record.terminalId,
          cwd: thread.worktreePath ?? project.value.workspaceRoot,
          worktreePath: thread.worktreePath,
          env: projectScriptRuntimeEnv({
            project: { cwd: project.value.workspaceRoot },
            worktreePath: thread.worktreePath,
          }),
          cols: 100,
          rows: 24,
          command: { command: input.command, language: input.language },
        }),
      );
      if (opened._tag === "Failure" || opened.success.status === "error") {
        const endedAt = yield* DateTime.now;
        const failed: InlineShellRunRecord = {
          ...record,
          status: "error",
          completedAt: DateTime.formatIso(endedAt),
          durationMs: Math.max(0, DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(now)),
        };
        yield* persist(failed);
        active.delete(key);
        return failed;
      }
      const latest = yield* projection.getTurnItem({ threadId: input.threadId, itemId });
      return latest?.type === "system_notice" ? (latest.inlineShellRun ?? record) : record;
    });
    const latest = Effect.fn("InlineShellRuns.latest")(function* (
      input: InlineShellRunLookupInput,
    ) {
      yield* projection.getThread(input.threadId);
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${input.threadId} AND type = 'system_notice' AND json_extract(payload_json, '$.inlineShellRun.blockId') = ${input.blockId} ORDER BY json_extract(payload_json, '$.inlineShellRun.startedAt') DESC, rowid DESC LIMIT 1`;
      if (rows[0] === undefined) return null;
      const item = yield* decodeStoredItem(rows[0].payload_json);
      return item.type === "system_notice" ? (item.inlineShellRun ?? null) : null;
    });
    return InlineShellRuns.of({
      latest: (input) =>
        latest(input).pipe(
          Effect.mapError((cause) => new InlineShellRunError({ threadId: input.threadId, cause })),
        ),
      run: (input) =>
        lock
          .withPermits(1)(run(input))
          .pipe(
            Effect.uninterruptible,
            Effect.mapError(
              (cause) => new InlineShellRunError({ threadId: input.threadId, cause }),
            ),
          ),
    });
  }),
);
