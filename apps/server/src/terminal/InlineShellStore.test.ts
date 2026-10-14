import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  MessageId,
  INLINE_SHELL_OUTPUT_BYTES,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { InlineShellStore, type InlineShellDelivery } from "./InlineShellStore.ts";
import { persistence, record, seed } from "./InlineShellRuns.testkit.ts";

const threadId = ThreadId.make("inline-store");
const delivery = (id: string, compact = false): InlineShellDelivery => ({
  threadId,
  deliveryId: id,
  runId: RunId.make(`run-${id}`),
  attemptId: RunAttemptId.make(`attempt-${id}`),
  providerTurnId: null,
  messageId: MessageId.make(`message-${id}`),
  text: compact ? "/compact" : "Explain the result",
  compact,
});
const complete = (id: string) =>
  Effect.gen(function* () {
    const store = yield* InlineShellStore;
    const running = yield* store.insert(record(threadId, id));
    if (!running) return yield* Effect.die("Missing record");
    yield* store.update({
      ...running,
      status: "completed",
      completedAt: "2026-10-13T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 7,
      output: `result-${id}`,
    });
  });

it.effect(
  "shares once after acceptance, leaves a raced completion pending, skips compact and never replays into a fresh native thread",
  () =>
    Effect.gen(function* () {
      yield* seed(threadId);
      const store = yield* InlineShellStore;
      const sql = yield* SqlClient.SqlClient;
      yield* complete("first");
      expect(yield* store.deliver(delivery("compact", true), Effect.succeed)).toBe("/compact");
      const read = yield* Deferred.make<string>();
      const accepted = yield* Deferred.make<void>();
      const turn = yield* store
        .deliver(delivery("normal"), (text) =>
          Deferred.succeed(read, text).pipe(Effect.andThen(Deferred.await(accepted))),
        )
        .pipe(Effect.forkScoped);
      expect(yield* Deferred.await(read)).toContain("result-first");
      // The next result arrives after the prompt was read but before the adapter accepts.
      yield* complete("raced");
      yield* Deferred.succeed(accepted, undefined);
      yield* Fiber.join(turn);
      const events = yield* sql<{
        record_ids_json: string;
      }>`SELECT record_ids_json FROM inline_shell_delivery_events`;
      expect(events.map((event) => JSON.parse(event.record_ids_json))).toEqual([["first"]]);
      const freshPrompt = yield* store.deliver(delivery("fresh-native"), Effect.succeed);
      expect(freshPrompt).toContain("result-raced");
      expect(freshPrompt).not.toContain("result-first");
      expect(yield* store.deliver(delivery("another-native"), Effect.succeed)).toBe(
        "Explain the result",
      );
      yield* complete("after-retry");
      expect(yield* store.deliver(delivery("normal"), Effect.succeed)).toBe("Explain the result");
      expect(yield* store.deliver(delivery("new-turn"), Effect.succeed)).toContain(
        "result-after-retry",
      );
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retains records on rejected starts and steering, then records the accepting steering turn",
  () =>
    Effect.gen(function* () {
      yield* seed(threadId);
      yield* complete("failed");
      const store = yield* InlineShellStore;
      const rejected = yield* store
        .deliver(delivery("rejected"), () => Effect.fail("provider rejected"))
        .pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      const input = {
        ...delivery("steering"),
        attemptId: null,
        providerTurnId: ProviderTurnId.make("active-turn"),
      };
      expect(
        yield* store.deliver({ ...input, compact: true, text: "/compact" }, Effect.succeed),
      ).toBe("/compact");
      expect(yield* store.deliver(input, Effect.succeed)).toContain("result-failed");
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT provider_turn_id, record_ids_json FROM inline_shell_delivery_events`,
      ).toEqual([{ provider_turn_id: "active-turn", record_ids_json: '["failed"]' }]);
    }).pipe(Effect.provide(persistence)),
);

it.effect(
  "caps the total shared context and prefers newest runs while leaving earlier ones pending",
  () =>
    Effect.gen(function* () {
      yield* seed(threadId);
      const store = yield* InlineShellStore;
      for (let n = 0; n < 80; n++) {
        const run = yield* store.insert({
          ...record(threadId, `run-${n}`),
          command: `run ${n} ${"😀".repeat(2000)}`,
        });
        yield* store.update({
          ...run!,
          status: "completed",
          completedAt: "2026-10-13T00:00:01.000Z",
          output: "😀".repeat(4096),
          exitCode: 0,
        });
      }
      const text = yield* store.deliver(delivery("bounded"), Effect.succeed);
      const context = text.slice(0, -"\n\nExplain the result".length);
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(INLINE_SHELL_OUTPUT_BYTES);
      expect(context).toContain("run 79");
      expect(context).not.toContain("User ran shell command (bash): run 0 ");
      expect(context).toMatch(/\d+ earlier runs omitted\./);
      expect(context).not.toContain("�");
      const sql = yield* SqlClient.SqlClient;
      const pending = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM inline_shell_runs WHERE delivered_by IS NULL`;
      expect(pending[0]?.count).toBeGreaterThan(0);
    }).pipe(Effect.provide(persistence)),
);

it.effect(
  "recovers indexed bounded batches, preserves saved tails, and skips malformed records without failing startup",
  () =>
    Effect.gen(function* () {
      yield* seed(threadId);
      const store = yield* InlineShellStore;
      const sql = yield* SqlClient.SqlClient;
      for (let n = 0; n < 105; n++)
        yield* store.insert({ ...record(threadId, `recover-${n}`), output: `last-tail-${n}` });
      yield* sql`UPDATE inline_shell_runs SET record_json = 'malformed' WHERE run_id = 'recover-0'`;
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT sequence, thread_id, record_json FROM inline_shell_runs INDEXED BY inline_shell_runs_running WHERE status = 'running' ORDER BY sequence LIMIT 100`;
      expect(plan.map((row) => row.detail).join(" ")).toContain("inline_shell_runs_running");
      expect(yield* store.recover()).toBe(100);
      expect(yield* store.get(threadId, "recover-1")).toMatchObject({
        status: "interrupted",
        output: "last-tail-1",
        error: "The server restarted before this run ended.",
      });
      expect((yield* store.get(threadId, "recover-104"))?.status).toBe("running");
      expect(yield* store.recover()).toBe(5);
      expect(yield* store.recover()).toBe(0);
      expect((yield* store.get(threadId, "recover-104"))?.status).toBe("interrupted");
      const pointRead = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT record_json FROM inline_shell_runs WHERE thread_id = ${threadId} AND block_id = 'message:0' ORDER BY sequence DESC LIMIT 1`;
      expect(pointRead.map((row) => row.detail).join(" ")).toContain("inline_shell_runs_block");
      expect((yield* store.latest({ threadId, blockId: "message:0" }))?.runId).toBe("recover-104");
    }).pipe(Effect.provide(persistence)),
);
