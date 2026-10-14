import * as NodeUtil from "node:util";
import {
  INLINE_SHELL_OUTPUT_BYTES,
  INLINE_SHELL_OUTPUT_LINES,
  InlineShellRunError,
  type InlineShellRunLookupInput,
  type InlineShellRunInput,
  type InlineShellRunRecord,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { inlineShellOutputTail } from "@t3tools/shared/inlineShell";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { TerminalManager, BoundedTerminalHistory } from "./Manager.ts";
import { InlineShellStore } from "./InlineShellStore.ts";

export class InlineShellRuns extends Context.Service<
  InlineShellRuns,
  {
    readonly latest: (
      input: InlineShellRunLookupInput,
    ) => Effect.Effect<InlineShellRunRecord | null, InlineShellRunError>;
    readonly observe: (
      input: InlineShellRunLookupInput,
    ) => Stream.Stream<InlineShellRunRecord | null, InlineShellRunError>;
    readonly run: (
      input: InlineShellRunInput,
    ) => Effect.Effect<InlineShellRunRecord, InlineShellRunError>;
    readonly recovered: Effect.Effect<void>;
  }
>()("t3/terminal/InlineShellRuns") {}

export const layer = Layer.effect(
  InlineShellRuns,
  Effect.gen(function* () {
    const terminal = yield* TerminalManager;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const store = yield* InlineShellStore;
    const launches = yield* KeyedLock.make<string>();
    const changes = yield* PubSub.unbounded<InlineShellRunRecord>();
    const active = new Map<
      string,
      { record: InlineShellRunRecord; history: BoundedTerminalHistory; dirty: boolean }
    >();
    const recovered = yield* Deferred.make<void>();
    // Recover in bounded indexed batches outside the layer's startup critical path.
    yield* Effect.gen(function* () {
      while ((yield* store.recover()) === 100) yield* Effect.yieldNow;
    }).pipe(Effect.ensuring(Deferred.succeed(recovered, undefined)), Effect.forkScoped);
    const keyOf = (threadId: string, terminalId: string) =>
      `${threadId.length}:${threadId}:${terminalId}`;
    const releases = yield* makeKeyedCoalescingWorker({
      merge: (_: InlineShellRunRecord, next: InlineShellRunRecord) => next,
      // Launch errors are emitted while Manager holds its thread lock. Release only
      // after the listener returns, from this scoped worker, to avoid reentering it.
      process: (_: string, record: InlineShellRunRecord) =>
        terminal
          .close({ threadId: record.threadId, terminalId: record.terminalId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not release inline terminal", cause),
            ),
          ),
    });
    const tail = (entry: { history: BoundedTerminalHistory }) =>
      inlineShellOutputTail(NodeUtil.stripVTControlCharacters(entry.history.value()));
    const finish = Effect.fn("InlineShellRuns.finish")(function* (
      key: string,
      result: {
        status: InlineShellRunRecord["status"];
        exitCode: number | null;
        error: string | null;
      },
    ) {
      const entry = active.get(key);
      if (!entry) return;
      // One owner removes the active run before any I/O. Synchronous launch errors
      // and openCommand's fallback cannot both persist the same completion.
      active.delete(key);
      const now = yield* DateTime.now;
      const record: InlineShellRunRecord = {
        ...entry.record,
        ...result,
        output: tail(entry),
        completedAt: DateTime.formatIso(now),
        durationMs: Math.max(0, DateTime.toEpochMillis(now) - Date.parse(entry.record.startedAt)),
      };
      yield* store.update(record).pipe(
        Effect.tap((saved) => (saved ? PubSub.publish(changes, record) : Effect.void)),
        Effect.ensuring(releases.enqueue(key, record)),
      );
    });
    const unsubscribe = yield* terminal.subscribe((event) =>
      Effect.gen(function* () {
        const key = keyOf(event.threadId, event.terminalId);
        const entry = active.get(key);
        if (!entry) return;
        if (event.type === "output") {
          entry.history.append(event.data);
          entry.dirty = true;
          return;
        }
        if (event.type === "exited" || event.type === "closed" || event.type === "error") {
          yield* finish(key, {
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
            error: event.type === "error" ? event.message.slice(0, 1024) : null,
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not persist inline shell completion", cause),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    // Persist at most once per second per active run; never broadcast progress
    // records. The existing PTY stream owns live output.
    yield* Effect.gen(function* () {
      yield* Effect.sleep("1 second");
      for (const entry of active.values()) {
        if (!entry.dirty) continue;
        entry.dirty = false;
        yield* store
          .update({ ...entry.record, output: tail(entry) })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not save inline shell tail", cause),
            ),
          );
      }
    }).pipe(Effect.forever, Effect.forkScoped);

    const run = Effect.fn("InlineShellRuns.run")(function* (input: InlineShellRunInput) {
      yield* Deferred.await(recovered);
      const existing = yield* store.get(input.threadId, input.runId);
      if (existing) return existing;
      const thread = yield* projection.getThread(input.threadId);
      if (thread.projectId === null || thread.archivedAt !== null || thread.deletedAt !== null)
        return yield* new InlineShellRunError({ threadId: input.threadId });
      const project = yield* projects.getShell(thread.projectId);
      if (Option.isNone(project))
        return yield* new InlineShellRunError({ threadId: input.threadId });
      const now = yield* DateTime.now;
      const record = yield* store.insert({
        ...input,
        terminalId: `inline-${input.runId}`,
        sequence: 0,
        error: null,
        status: "running",
        startedAt: DateTime.formatIso(now),
        completedAt: null,
        exitCode: null,
        durationMs: 0,
        output: "",
      });
      if (!record) return yield* new InlineShellRunError({ threadId: input.threadId });
      const key = keyOf(input.threadId, record.terminalId);
      active.set(key, {
        record,
        history: new BoundedTerminalHistory(
          INLINE_SHELL_OUTPUT_LINES,
          "",
          INLINE_SHELL_OUTPUT_BYTES,
        ),
        dirty: false,
      });
      yield* PubSub.publish(changes, record);
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
        yield* finish(key, {
          status: "error",
          exitCode: null,
          error:
            opened._tag === "Failure"
              ? String(opened.failure).slice(0, 1024)
              : "The shell could not start.",
        });
      }
      return (yield* store.get(input.threadId, input.runId)) ?? record;
    });
    return InlineShellRuns.of({
      latest: (input) => Deferred.await(recovered).pipe(Effect.andThen(store.latest(input))),
      recovered: Deferred.await(recovered),
      observe: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Deferred.await(recovered);
            const subscription = yield* PubSub.subscribe(changes);
            const snapshot = yield* store.latest(input);
            return Stream.concat(
              Stream.make(snapshot),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (record) =>
                    record.threadId === input.threadId && record.blockId === input.blockId,
                ),
              ),
            );
          }),
        ),
      run: (input) =>
        launches
          .withLock(input.threadId, run(input))
          .pipe(
            Effect.mapError(
              (cause) => new InlineShellRunError({ threadId: input.threadId, cause }),
            ),
          ),
    });
  }),
);
