import { expect, it } from "@effect/vitest";
import type { ApplicationStoredEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  coalesceShellApplicationEvents,
  SHELL_COALESCE_WINDOW,
  toShellApplicationEvent,
} from "./ShellStream.ts";

it.effect("reduces shell projections for streaming items while retaining final state", () =>
  Effect.gen(function* () {
    const source = Stream.fromIterable(Array.from({ length: 201 }, (_, index) => index + 1)).pipe(
      Stream.mapEffect((sequence) =>
        Effect.sleep("20 millis").pipe(
          Effect.as(
            toShellApplicationEvent({
              sequence,
              event: {
                type: "turn-item.updated",
                threadId: ThreadId.make("thread:shell-streaming"),
              },
            } as OrchestrationV2StoredEvent),
          ),
        ),
      ),
    );
    const collect = (window: Duration.Input) =>
      source.pipe(
        Stream.groupedWithin(512, window),
        Stream.flatMap((batch) => Stream.fromIterable(coalesceShellApplicationEvents(batch))),
        Stream.runCollect,
      );
    const before = yield* collect("50 millis").pipe(Effect.forkScoped);
    const after = yield* collect(SHELL_COALESCE_WINDOW).pipe(Effect.forkScoped);
    yield* TestClock.adjust("10 seconds");
    const beforeProjections = yield* Fiber.join(before);
    const afterProjections = yield* Fiber.join(after);
    expect(afterProjections.length).toBeLessThan(beforeProjections.length / 10);
    expect(afterProjections.at(-1)?.sequence).toBe(201);
  }),
);

// A native child's lifecycle is stored on its parent, but its navigation row must refresh.
it("refreshes native child shells without retaining the parent's subagent body", () => {
  const stored = (origin: "provider_native" | "app_owned") =>
    ({
      sequence: 7,
      event: {
        threadId: "thread-parent",
        type: "subagent.updated",
        payload: { origin, childThreadId: "thread-child" },
      },
    }) as unknown as ApplicationStoredEvent;
  expect(toShellApplicationEvent(stored("provider_native"))).toEqual({
    sequence: 7,
    event: { threadId: "thread-child" },
  });
  expect(toShellApplicationEvent(stored("app_owned"))).toEqual({
    sequence: 7,
    event: { threadId: "thread-parent" },
  });
});
