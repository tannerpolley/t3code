import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import {
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnNoUpdate,
} from "./updateMachine.ts";

class ForkStagedUpdateChangedError extends Schema.TaggedError<ForkStagedUpdateChangedError>()(
  "ForkStagedUpdateChangedError",
  {},
) {}

class ForkLauncherNotExecutableError extends Schema.TaggedError<ForkLauncherNotExecutableError>()(
  "ForkLauncherNotExecutableError",
  { launcher: Schema.String },
) {}

/** sort -V ordering for the dotted numeric versions used by fork releases. */
export function compareForkVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return leftParts.length - rightParts.length || (left < right ? -1 : left > right ? 1 : 0);
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const installedVersion = environment.appVersion.match(/-v(2\.\d+(?:\.\d+)*)$/)?.[1];
  if (
    !installedVersion ||
    environment.platform !== "linux" ||
    environment.processArch !== "x64" ||
    !environment.isPackaged ||
    environment.isDevelopment ||
    config.disableAutoUpdate ||
    Option.isNone(config.appImagePath)
  ) {
    return undefined;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const app = yield* ElectronApp.ElectronApp;
  const pendingDirectory = environment.path.join(
    environment.homeDirectory,
    ".local/opt/t3-code/pending",
  );
  const launcher = environment.path.join(environment.homeDirectory, ".local/bin/t3-code");

  const readStagedBuild = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(pendingDirectory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as string[]),
      ),
    );
    const builds = entries.flatMap((name) => {
      const match = name.match(/^T3-Code-(\d+(?:\.\d+)*)-v(2\.\d+(?:\.\d+)*)-x86_64\.AppImage$/);
      return match ? [{ name, base: match[1]!, version: match[2]! }] : [];
    });
    // The launcher sorts whole filenames: the upstream base precedes the fork version.
    builds.sort(
      (a, b) => compareForkVersions(a.base, b.base) || compareForkVersions(a.version, b.version),
    );
    const latest = builds.at(-1);
    if (!latest || compareForkVersions(latest.version, installedVersion) <= 0) return null;
    const info = yield* fileSystem.stat(environment.path.join(pendingDirectory, latest.name));
    return info.type === "File" && info.size > 0 ? `${latest.base}-v${latest.version}` : null;
  });

  return {
    check: (state: DesktopUpdateState, checkedAt: string) =>
      readStagedBuild.pipe(
        Effect.map((version) => {
          // A removed staged build must clear the pill, unlike a cached upstream download.
          const cleared = reduceDesktopUpdateStateOnNoUpdate(
            { ...state, downloadedVersion: null },
            checkedAt,
          );
          return version ? reduceDesktopUpdateStateOnDownloadComplete(cleared, version) : cleared;
        }),
        Effect.mapError(
          (cause) =>
            new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
              channel: state.channel,
              cause,
            }),
        ),
      ),
    install: Effect.fn("desktop.forkStagedUpdates.install")(
      function* (expectedVersion: string | null) {
        const version = yield* readStagedBuild;
        if (version === null || version !== expectedVersion) {
          return yield* new ForkStagedUpdateChangedError();
        }
        // Electron runs the launcher only after this process exits, too late to recover from a
        // launcher it cannot execute, so check it is an executable file first.
        const info = yield* fileSystem.stat(launcher);
        if (info.type !== "File" || (info.mode & 0o111) === 0) {
          return yield* new ForkLauncherNotExecutableError({ launcher });
        }
        // The launcher must wait for this PID before installing or taking the instance lock.
        yield* app.relaunch({
          execPath: launcher,
          args: ["--update-from-pid", String(process.pid)],
        });
        yield* app.quit;
      },
      Effect.mapError((cause) =>
        cause._tag === "ForkStagedUpdateChangedError"
          ? cause
          : new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: null,
              isSilent: true,
              isForceRunAfter: true,
              cause,
            }),
      ),
    ),
  };
});
