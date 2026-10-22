import { assert, describe, it } from "@effect/vitest";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("keeps fork builds off the upstream update feed", () => {
    const harness = makeHarness({
      appVersion: "0.0.45-v2.1",
      env: { T3CODE_DISABLE_AUTO_UPDATE: "false" },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* updates.check("manual");
        assert.equal(result.checked, false);
        yield* TestClock.adjust(Duration.hours(2));

        const state = yield* updates.getState;
        assert.equal(state.enabled, false);
        assert.equal(state.status, "disabled");
        assert.deepEqual(
          yield* updates.disabledReason,
          Option.some("Automatic updates are disabled for fork builds."),
        );
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.listenerCount(), 0);
        assert.deepEqual(harness.feedUrls(), []);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
