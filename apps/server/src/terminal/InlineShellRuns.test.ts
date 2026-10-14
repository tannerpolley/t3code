import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  INLINE_SHELL_OUTPUT_BYTES,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { TerminalManager } from "./Manager.ts";
import { InlineShellRuns, layer } from "./InlineShellRuns.ts";
import { persistence, seed, record } from "./InlineShellRuns.testkit.ts";

it.effect.each([false, true])(
  "streams, persists and releases inline PTYs (launch failure: %s)",
  (failure) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-inline-record");
      yield* seed(threadId);
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const emit = (event: TerminalEvent) =>
        Effect.suspend(() => (listener ? listener(event) : Effect.die("No listener")));
      const closed = yield* Deferred.make<void>();
      const subscribed = yield* Deferred.make<void>();
      const launches: unknown[] = [];
      const terminal = Layer.mock(TerminalManager)({
        subscribe: (callback) =>
          Effect.sync(() => {
            listener = callback;
            return () => {
              listener = null;
            };
          }),
        close: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        openCommand: (input) =>
          Effect.gen(function* () {
            launches.push(input);
            if (failure)
              yield* emit({
                threadId,
                terminalId: input.terminalId,
                type: "error",
                message: "No shell executable",
              });
            return {
              threadId,
              terminalId: input.terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: failure ? "error" : "running",
              pid: failure ? null : 42,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "test",
              updatedAt: "2026-10-13T00:00:00.000Z",
            } satisfies TerminalSessionSnapshot;
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* InlineShellRuns;
        yield* service.recovered;
        const input = record(threadId);
        const events = yield* service.observe({ threadId, blockId: input.blockId }).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        const running = yield* service.run(input);
        if (!failure) {
          const output =
            Array.from({ length: 400 }, (_, n) => `line-${n}: ${"😀".repeat(60)}`).join("\n") +
            "\n";
          yield* emit({ threadId, terminalId: running.terminalId, type: "output", data: output });
          yield* emit({
            threadId,
            terminalId: running.terminalId,
            type: "exited",
            exitCode: 7,
            exitSignal: 0,
          });
        }
        yield* Deferred.await(closed);
        const lifecycle = yield* Fiber.join(events);
        expect(lifecycle.map((item) => item?.status ?? null)).toEqual([
          null,
          "running",
          failure ? "error" : "completed",
        ]);
        const saved = yield* service.latest({ threadId, blockId: input.blockId });
        expect(saved).toMatchObject({
          command: input.command,
          status: failure ? "error" : "completed",
          exitCode: failure ? null : 7,
          error: failure ? "No shell executable" : null,
        });
        expect(saved?.completedAt).not.toBeNull();
        expect(new TextEncoder().encode(saved!.output).length).toBeLessThanOrEqual(
          INLINE_SHELL_OUTPUT_BYTES,
        );
        if (!failure) {
          expect(saved!.output).toContain("line-399:");
          expect(saved!.output).not.toContain("line-0:");
        }
        yield* service.run(input);
        yield* emit({ threadId, terminalId: running.terminalId, type: "closed" });
        expect(yield* service.latest({ threadId, blockId: input.blockId })).toEqual(saved);
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatchObject({
          cwd: "/tmp/inline-worktree",
          command: { command: input.command, language: "bash" },
        });
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`,
        ).toEqual([]);
        expect(yield* sql`SELECT sequence FROM inline_shell_runs`).toHaveLength(1);
      }).pipe(Effect.provide(layer.pipe(Layer.provide(terminal))));
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["archived_at", "deleted_at"])(
  "releases a killed session without writing to a thread with %s",
  (column) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-killed");
      yield* seed(threadId);
      const sql = yield* SqlClient.SqlClient;
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const released = yield* Deferred.make<void>();
      const terminal = Layer.mock(TerminalManager)({
        subscribe: (callback) =>
          Effect.sync(() => {
            listener = callback;
            return () => {};
          }),
        close: () => Deferred.succeed(released, undefined).pipe(Effect.asVoid),
        openCommand: (input) =>
          Effect.succeed({
            threadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: null,
            status: "running",
            pid: 1,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "shell",
            updatedAt: "2026-10-13T00:00:00.000Z",
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* InlineShellRuns;
        yield* service.recovered;
        const running = yield* service.run(record(threadId));
        yield* sql`UPDATE orchestration_v2_projection_threads SET ${sql(column)} = '2026-10-13T00:00:01Z' WHERE thread_id = ${threadId}`;
        yield* Effect.suspend(() =>
          listener
            ? listener({ threadId, terminalId: running.terminalId, type: "closed" })
            : Effect.die("No listener"),
        );
        yield* Deferred.await(released);
        expect((yield* service.latest({ threadId, blockId: running.blockId }))?.status).toBe(
          "running",
        );
      }).pipe(Effect.provide(layer.pipe(Layer.provide(terminal))));
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);
