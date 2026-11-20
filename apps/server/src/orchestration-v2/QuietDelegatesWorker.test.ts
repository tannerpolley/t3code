import { it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import { Scheduler } from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { workerLive } from "./QuietDelegatesWorker.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

it.effect("wakes the parent once per quiet stretch using only the quiet candidate index", () =>
  Effect.gen(function* () {
    const child = {
      threadId: ThreadId.make("child"),
      parentThreadId: ThreadId.make("parent"),
      runId: RunId.make("run"),
      title: "Worker",
      quietActivityAt: null,
      hasActiveProviderWork: false,
      runtime: { status: "running" as const },
    };
    const getShellSnapshot = vi.fn(() => Effect.die("quiet sweep read the general shell"));
    let latestActivityAt = 0;
    let sweep = Effect.void;
    const dispatch = vi.fn<ThreadManagementService["Service"]["dispatch"]>(() =>
      Effect.succeed({ sequence: 1, storedEvents: [] }),
    );
    yield* Layer.build(
      workerLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(Scheduler)({
              register: (_name, work) =>
                Effect.context<Effect.Services<typeof work>>().pipe(
                  Effect.tap((context) =>
                    Effect.sync(() => {
                      sweep = work.pipe(Effect.provideContext(context), Effect.orDie);
                    }),
                  ),
                  Effect.asVoid,
                ),
            }),
            Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
            Layer.mock(ProjectionStoreV2)({
              getShellSnapshot,
              getQuietActivityCandidates: () =>
                Effect.sync(() => [{ ...child, lastProviderActivityAt: latestActivityAt }]),
            }),
            Layer.mock(ThreadManagementService)({ dispatch }),
            ServerSettings.layerTest({}),
          ),
        ),
      ),
    );
    yield* TestClock.setTime(599_999);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(getShellSnapshot).not.toHaveBeenCalled();
    yield* TestClock.setTime(659_999);
    yield* sweep;
    yield* sweep;
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "parent",
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
      }),
    );
    latestActivityAt = 660_000;
    yield* TestClock.setTime(latestActivityAt);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(1);
    yield* TestClock.setTime(latestActivityAt + 659_999);
    yield* sweep;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].commandId).not.toBe(dispatch.mock.calls[1]?.[0].commandId);
  }),
);
