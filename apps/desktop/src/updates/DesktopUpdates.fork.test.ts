import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

const validPattern = String.raw`^(\d+(?:\.\d+)*)-v(\d+(?:\.\d+)*)$`;
const directoryVariable = "T3CODE_STAGED_UPDATE_DIRECTORY";
const launcherVariable = "T3CODE_DESKTOP_LAUNCHER_PATH";
const patternVariable = "T3CODE_STAGED_UPDATE_VERSION_PATTERN";

describe("DesktopUpdates", () => {
  it.effect.each([
    { variable: patternVariable, value: undefined },
    { variable: patternVariable, value: "[" },
    { variable: patternVariable, value: String.raw`^(\d+(?:\.\d+)*)-v\d+(?:\.\d+)*$` },
    { variable: directoryVariable, value: "relative/staged" },
    { variable: launcherVariable, value: "relative/launcher" },
    { variable: launcherVariable, value: undefined },
    { variable: patternVariable, value: "" },
    { variable: directoryVariable, value: "", onlyStagedVariable: true },
    { variable: directoryVariable, value: "  ", onlyStagedVariable: true },
  ])(
    "warns and keeps invalid staged update configuration off the feed ($variable=$value)",
    ({ variable, value, onlyStagedVariable }) => {
      const harness = makeHarness({
        appVersion: "0.0.45-v2.12.15",
        platform: "linux",
        env: {
          APPIMAGE: "/opt/T3-Code.AppImage",
          [launcherVariable]: "/opt/launcher",
          [directoryVariable]: "/opt/staged",
          [patternVariable]: onlyStagedVariable ? undefined : validPattern,
          [variable]: value,
        },
        policy: {
          mode: "auto",
          allowNightly: true,
          feedUrl: "https://example.com/updates",
          message: null,
        },
      });

      const warnings: Array<Record<string, unknown>> = [];
      const logger = Logger.make(({ fiber, logLevel }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations);
        if (logLevel === "Warn" && annotations.variable !== undefined) {
          warnings.push(annotations);
        }
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
          assert.deepEqual(
            warnings.map(({ variable, value }) => ({ variable, value })),
            [{ variable, value: value ?? null }],
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            harness.layer.pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
          ),
        ),
      );
    },
  );
});
