import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { RelaunchOptions } from "electron";

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

const installed = "0.1.0-v2.12.9";
const offered = "0.1.0-v2.12.10";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const pending = path.join(root, "pending");
  const launcher = path.join(root, "t3-code");
  const handoff: (RelaunchOptions | "quit")[] = [];
  const harness = makeHarness({
    platform: "linux",
    appVersion: installed,
    beforeSetUpdateChannel: Effect.void,
    env: {
      APPIMAGE: path.join(root, `T3-Code-${installed}-x86_64.AppImage`),
      T3CODE_DESKTOP_LAUNCHER_PATH: launcher,
      T3CODE_STAGED_UPDATE_DIRECTORY: pending,
      T3CODE_STAGED_UPDATE_VERSION_PATTERN: String.raw`^(\d+(?:\.\d+)*)-v(2\.\d+(?:\.\d+)*)$`,
    },
    stagedFileSystem: { readDirectory: fs.readDirectory, stat: fs.stat },
    electronApp: {
      relaunch: (options) => Effect.sync(() => void handoff.push(options)),
      quit: Effect.sync(() => void handoff.push("quit")),
    },
  });
  const image = (version: string) => path.join(pending, `T3-Code-${version}-x86_64.AppImage`);
  const stage = (version: string, data = "appimage") =>
    fs
      .makeDirectory(pending, { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(image(version), data)));
  yield* fs.writeFileString(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  return { fs, path, pending, launcher, handoff, harness, image, stage };
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("staged AppImage updates", () => {
  it.effect("applies the selected track and minimum version to staged offers", () =>
    Effect.gen(function* () {
      const { harness, stage } = yield* fixture;
      yield* stage(offered);
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.check("manual")).state.downloadedVersion, offered);
        const nightly = yield* updates.setChannel("nightly", {
          minimumVersion: "0.0.99-nightly.20261125.1",
        });
        assert.isNull(nightly.downloadedVersion);
        const minimumVersion = "0.1.0-v2.12.11";
        const belowFloor = yield* updates.setChannel("latest", { minimumVersion });
        assert.isNull(belowFloor.downloadedVersion);
        yield* stage(minimumVersion);
        assert.equal((yield* updates.check("manual")).state.downloadedVersion, minimumVersion);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "offers a build staged after startup within minutes, checking only once it appears",
    () =>
      Effect.gen(function* () {
        const { harness, stage } = yield* fixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const { changes } = yield* updates.subscribe;
            const statuses: string[] = [];
            const offer = yield* changes.pipe(
              Stream.tap((state) => Effect.sync(() => void statuses.push(state.status))),
              Stream.filter((state) => state.downloadedVersion === offered),
              Stream.runHead,
              Effect.forkScoped,
            );
            yield* TestClock.adjust("15 seconds");
            yield* TestClock.adjust("3 minutes");
            yield* stage(offered);
            yield* TestClock.adjust("3 minutes");
            assert.isTrue(Option.isSome(yield* Fiber.join(offer)));
            // The startup check and the one for the new build; empty polls stay invisible.
            assert.equal(statuses.filter((status) => status === "checking").length, 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "offers the newer AppImage the launcher would select and clears an unusable offer",
    () =>
      Effect.gen(function* () {
        const { fs, path, pending, harness, image, stage } = yield* fixture;
        yield* Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.equal((yield* updates.check("manual")).state.status, "up-to-date");
          yield* stage(installed);
          assert.isNull((yield* updates.check("manual")).state.downloadedVersion);
          yield* stage("0.0.99-v2.99.99");
          yield* stage(offered);
          yield* fs.writeFileString(path.join(pending, "README"), "ignored");
          const offer = (yield* updates.check("manual")).state;
          assert.equal(offer.status, "downloaded");
          assert.equal(offer.downloadedVersion, offered);
          yield* stage("0.1.0-v2.12.11", "");
          assert.equal((yield* updates.check("manual")).state.status, "up-to-date");
          yield* stage("0.1.0-v2.12.11");
          const badDirectory = image("0.0.99-v2.11.0");
          yield* fs.makeDirectory(badDirectory);
          assert.isNull((yield* updates.check("manual")).state.downloadedVersion);
          yield* fs.remove(badDirectory, { recursive: true });
          yield* fs.writeFileString(
            path.join(pending, "T3-Code-9.0.0-arm64.AppImage"),
            "wrong target",
          );
          assert.isNull((yield* updates.check("manual")).state.downloadedVersion);
          assert.equal(harness.checkCount(), 0);
          assert.deepEqual(harness.feedUrls(), []);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { scenario: "ready" },
    { scenario: "replaced" },
    { scenario: "removed" },
    { scenario: "non-executable" },
    { scenario: "unreadable" },
  ])("revalidates the staged handoff before quitting ($scenario)", ({ scenario }) =>
    Effect.gen(function* () {
      const { fs, pending, launcher, handoff, harness, image, stage } = yield* fixture;
      yield* stage(offered);
      if (scenario !== "non-executable") yield* fs.chmod(launcher, 0o700);
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const state = yield* DesktopState.DesktopState;
        yield* updates.configure;
        yield* updates.check("manual");
        const replacement = "0.1.0-v2.12.11";
        if (scenario === "replaced") yield* stage(replacement);
        if (scenario === "removed") yield* fs.remove(image(offered));
        if (scenario === "unreadable") {
          yield* fs.rename(pending, `${pending}-original`);
          yield* fs.writeFileString(pending, "The staged directory is no longer readable.");
        }

        const result = yield* updates.installPrepared(offered);
        if (scenario === "ready") {
          assert.isTrue(result.accepted);
          assert.isFalse(result.failed);
          assert.deepEqual(handoff, [
            { execPath: launcher, args: ["--update-from-pid", String(process.pid)] },
            "quit",
          ]);
          assert.isTrue(yield* Ref.get(state.quitting));
        } else {
          const failed = scenario === "non-executable" || scenario === "unreadable";
          assert.equal(result.failed, failed);
          assert.equal(result.accepted, failed);
          if (scenario === "unreadable") {
            assert.equal(result.state.errorContext, "install");
            assert.include(result.state.message ?? "", "Could not read the staged AppImage");
          }
          assert.equal(
            result.state.downloadedVersion,
            scenario === "removed" ? null : scenario === "replaced" ? replacement : offered,
          );
          assert.deepEqual(handoff, []);
          assert.isFalse(yield* Ref.get(state.quitting));
          assert.equal(harness.installRecords.size, 0);
        }
        assert.equal(harness.quitAndInstalls(), 0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
