import { assert, describe, it } from "@effect/vitest";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect.each([
    { versionPattern: undefined },
    { versionPattern: "[" },
    { versionPattern: String.raw`^(\d+(?:\.\d+)*)-v(\w+)$` },
  ])(
    "keeps invalid staged update configuration off the feed ($versionPattern)",
    ({ versionPattern }) => {
      const harness = makeHarness({
        appVersion: "0.0.45-vtest",
        platform: "linux",
        env: {
          APPIMAGE: "/opt/T3-Code.AppImage",
          T3CODE_DESKTOP_LAUNCHER_PATH: "/opt/launcher",
          T3CODE_STAGED_UPDATE_DIRECTORY: "/opt/staged",
          T3CODE_STAGED_UPDATE_VERSION_PATTERN: versionPattern,
        },
        policy: {
          mode: "auto",
          allowNightly: true,
          feedUrl: "https://example.com/updates",
          message: null,
        },
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
            Option.some("Staged updates are unavailable for this build or launcher configuration."),
          );
          assert.equal(harness.checkCount(), 0);
          assert.equal(harness.listenerCount(), 0);
          assert.deepEqual(harness.feedUrls(), []);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
});
