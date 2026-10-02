import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionMaintenanceError, ProjectionMaintenanceV2 } from "./ProjectionMaintenance.ts";
import * as EventStoreCompaction from "./EventStoreCompaction.ts";

it.effect("compacts at startup and keeps retrying hourly after failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runs = yield* Queue.unbounded<number>();
      let runCount = 0;
      const maintenance: ProjectionMaintenanceV2["Service"] = {
        verify: Effect.die("unused"),
        rebuild: Effect.die("unused"),
        compactEventStore: Effect.suspend(() => {
          runCount += 1;
          return Queue.offer(runs, runCount).pipe(
            Effect.andThen(
              runCount === 1
                ? Effect.fail(new ProjectionMaintenanceError({ operation: "fixture" }))
                : Effect.succeed({
                    deletedEventCount: 0,
                    deletedReceiptCount: 0,
                    reclaimableBytes: 0,
                  }),
            ),
          );
        }),
      };

      yield* Layer.launch(
        EventStoreCompaction.workerLive.pipe(
          Layer.provide(Layer.succeed(ProjectionMaintenanceV2, maintenance)),
        ),
      ).pipe(Effect.forkScoped);

      assert.equal(yield* Queue.take(runs), 1);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.take(runs), 2);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.take(runs), 3);
    }),
  ),
);
