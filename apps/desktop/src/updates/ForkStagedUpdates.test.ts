import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as Ref from "effect/Ref";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { compareForkVersions } from "./ForkStagedUpdates.ts";
import { makeHarness, type UpdatesHarnessOptions } from "./updatesTestHarness.ts";

const buildName = (version: string) => `T3-Code-0.0.45-v${version}-x86_64.AppImage`;

const withForkHarness = <E>(
  test: (fixture: {
    home: string;
    stage: (version: string) => Effect.Effect<void, PlatformError.PlatformError>;
    clear: () => Effect.Effect<void, PlatformError.PlatformError>;
    chmodLauncher: (mode: number) => Effect.Effect<void, PlatformError.PlatformError>;
    harness: ReturnType<typeof makeHarness>;
  }) => Effect.Effect<
    void,
    E,
    DesktopUpdates.DesktopUpdates | DesktopState.DesktopState | Scope.Scope
  >,
  options: UpdatesHarnessOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fork-updates-" });
      const pending = join(home, ".local/opt/t3-code/pending");
      const launcher = join(home, ".local/bin/t3-code");
      yield* fileSystem.makeDirectory(join(home, ".local/bin"), { recursive: true });
      yield* fileSystem.writeFileString(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const harness = makeHarness({
        appVersion: "0.0.45-v2.12.14",
        platform: "linux",
        homeDirectory: home,
        env: { APPIMAGE: "/installed/T3-Code.AppImage" },
        fileSystem: {
          readDirectory: fileSystem.readDirectory,
          stat: fileSystem.stat,
          access: fileSystem.access,
        },
        ...options,
      });
      yield* test({
        home,
        harness,
        stage: (version) =>
          fileSystem
            .makeDirectory(pending, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  join(pending, buildName(version)),
                  "staged build fixture",
                ),
              ),
            ),
        clear: () => fileSystem.remove(pending, { recursive: true, force: true }),
        chmodLauncher: (mode) => fileSystem.chmod(launcher, mode),
      }).pipe(Effect.provide(harness.layer));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())));

describe("ForkStagedUpdates", () => {
  it("orders dotted versions like sort -V, including fourth components and large numbers", () => {
    const versions = [
      "2.12.15",
      "2.12.14.1",
      "2.12.14",
      "2.12.9",
      "2.12.14.0",
      "2.012.14",
      "2.12.014",
      "2.12.999999999999999999999",
      "2.12.1000000000000000000000",
    ];
    const expected = [
      "2.12.9",
      "2.012.14",
      "2.12.014",
      "2.12.14",
      "2.12.14.0",
      "2.12.14.1",
      "2.12.15",
      "2.12.999999999999999999999",
      "2.12.1000000000000000000000",
    ];
    assert.deepEqual(versions.toSorted(compareForkVersions), expected);
    assert.equal(compareForkVersions("2.12.14", "2.12.14"), 0);
  });

  it.effect("never falls back to a feed when local fork updates are disabled or unsupported", () =>
    Effect.gen(function* () {
      for (const env of [
        { APPIMAGE: "/installed/T3-Code.AppImage", T3CODE_DISABLE_AUTO_UPDATE: "true" },
        { APPIMAGE: undefined, T3CODE_DISABLE_AUTO_UPDATE: "false" },
      ]) {
        const harness = makeHarness({ appVersion: "0.0.45-v2.12.14", platform: "linux", env });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            assert.isFalse((yield* updates.check("manual")).checked);
            yield* updates.setChannel("nightly");
            yield* TestClock.adjust(Duration.hours(2));
            assert.equal((yield* updates.getState).status, "disabled");
            assert.equal(harness.checkCount(), 0);
            assert.equal(harness.listenerCount(), 0);
            assert.deepEqual(harness.feedUrls(), []);
          }),
        ).pipe(Effect.provide(harness.layer));
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "reports only newer staged builds and clears removed builds without contacting a feed",
    () =>
      withForkHarness(({ stage, clear, harness }) =>
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.deepEqual(yield* updates.disabledReason, Option.none());
          const absent = yield* updates.check("manual");
          assert.equal(absent.state.status, "up-to-date");
          assert.isNull(absent.state.downloadedVersion);
          for (const version of ["2.12.13", "2.12.14", "2.12.14.1", "2.12.15"]) {
            yield* clear();
            yield* stage(version);
            const { state } = yield* updates.check("manual");
            const newer = version === "2.12.14.1" || version === "2.12.15";
            assert.equal(state.status, newer ? "downloaded" : "up-to-date");
            assert.equal(state.downloadedVersion, newer ? `0.0.45-v${version}` : null);
            assert.equal(state.availableVersion, state.downloadedVersion);
          }
          yield* clear();
          assert.isNull((yield* updates.check("manual")).state.downloadedVersion);
          yield* updates.setChannel("nightly");
          assert.isFalse((yield* updates.download).accepted);
          assert.equal(harness.checkCount(), 0);
          assert.equal(harness.listenerCount(), 0);
          assert.equal(harness.downloadCount(), 0);
          assert.deepEqual(harness.feedUrls(), []);
        }),
      ),
  );

  it.effect("discovers a build staged after startup on the existing poll interval", () =>
    withForkHarness(({ stage, harness }) =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        const startup = yield* Stream.runHead(
          changes.pipe(Stream.filter((state) => state.status === "up-to-date")),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(15));
        yield* Fiber.join(startup);
        assert.isNull((yield* updates.getState).downloadedVersion);
        yield* stage("2.12.14.1");
        yield* stage("2.12.15");
        const { changes: stagedChanges } = yield* updates.subscribe;
        const downloaded = yield* Stream.runHead(
          stagedChanges.pipe(Stream.filter((state) => state.status === "downloaded")),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.minutes(4));
        yield* Fiber.join(downloaded);
        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "0.0.45-v2.12.15");
        assert.equal(harness.checkCount(), 0);
      }),
    ),
  );

  it.effect(
    "schedules the launcher before lifecycle shutdown, even if backend stop would hang",
    () => {
      const steps: string[] = [];
      return withForkHarness(
        ({ home, stage, harness }) =>
          Effect.gen(function* () {
            yield* stage("2.12.15");
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            yield* updates.check("manual");
            const result = yield* updates.installPrepared("0.0.45-v2.12.15");
            assert.isTrue(result.accepted);
            assert.isFalse(result.failed);
            assert.deepEqual(steps, ["relaunch"]);
            assert.deepEqual(harness.installSteps, ["relaunch", "quit"]);
            assert.deepEqual(harness.relaunches, [
              {
                execPath: `${home}/.local/bin/t3-code`,
                args: ["--update-from-pid", String(process.pid)],
              },
            ]);
            assert.equal(harness.quitAndInstalls(), 0);
            const state = yield* DesktopState.DesktopState;
            assert.isTrue(yield* Ref.get(state.quitting));
            assert.deepEqual(
              [...harness.installRecords.values()].map((text) => JSON.parse(text)),
              [{ fromVersion: "0.0.45-v2.12.14", targetVersion: "0.0.45-v2.12.15" }],
            );
          }),
        {
          stopBackend: Effect.sync(() => {
            steps.push("stop");
          }).pipe(Effect.andThen(Effect.never)),
          relaunch: Effect.sync(() => {
            steps.push("relaunch");
          }),
        },
      );
    },
  );

  it.effect("recovers instead of quitting when the launcher cannot be executed", () =>
    withForkHarness(({ stage, chmodLauncher, harness }) =>
      Effect.gen(function* () {
        yield* stage("2.12.15");
        yield* chmodLauncher(0o644);
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("manual");
        const result = yield* updates.installPrepared("0.0.45-v2.12.15");
        assert.isTrue(result.failed);
        assert.deepEqual(harness.relaunches, []);
        const state = yield* DesktopState.DesktopState;
        assert.isFalse(yield* Ref.get(state.quitting));
      }),
    ),
  );

  it.effect("recovers instead of quitting when the confirmed staged build disappears", () =>
    withForkHarness(({ stage, clear, harness }) =>
      Effect.gen(function* () {
        yield* stage("2.12.15");
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("manual");
        yield* clear();
        const result = yield* updates.installPrepared("0.0.45-v2.12.15");
        assert.isTrue(result.failed);
        assert.deepEqual(harness.installSteps, []);
        assert.deepEqual(harness.relaunches, []);
        assert.equal(harness.installRecords.size, 0);
        assert.equal(harness.updateRestartMarkers.size, 0);
        const state = yield* DesktopState.DesktopState;
        assert.isFalse(yield* Ref.get(state.quitting));
      }),
    ),
  );
});
