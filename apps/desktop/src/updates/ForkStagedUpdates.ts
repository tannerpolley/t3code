import type { DesktopUpdateState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
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

const dottedVersion = /^\d+(?:\.\d+)*$/;
const { logWarning } = makeComponentLogger("desktop-fork-staged-updates");
const reject = (variable: string, value: string | undefined, reason: string) =>
  logWarning("staged updates disabled", { variable, value: value ?? null, reason }).pipe(
    Effect.as(null),
  );

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const env = yield* HostProcess.Environment;
  const variables = DesktopConfig.stagedUpdateVariables;
  const rawDirectory = env[variables.directory];
  const rawPattern = env[variables.versionPattern];
  if (rawDirectory === undefined && rawPattern === undefined) return undefined;

  const pendingDirectory = rawDirectory?.trim();
  if (!pendingDirectory || !environment.path.isAbsolute(pendingDirectory)) {
    return yield* reject(variables.directory, rawDirectory, "expected an absolute path");
  }
  const launcher = Option.getOrUndefined(environment.desktopLauncherPath);
  if (!launcher || !environment.path.isAbsolute(launcher)) {
    return yield* reject(variables.launcher, env[variables.launcher], "expected an absolute path");
  }
  const versionPattern = rawPattern?.trim();
  if (!versionPattern) {
    return yield* reject(variables.versionPattern, rawPattern, "expected a version pattern");
  }
  if (
    environment.platform !== "linux" ||
    environment.processArch !== "x64" ||
    !environment.isPackaged ||
    environment.isDevelopment
  ) {
    yield* logWarning("staged updates require a packaged Linux x64 build", {
      [variables.directory]: rawDirectory,
      [variables.versionPattern]: rawPattern,
      platform: environment.platform,
      arch: environment.processArch,
      isPackaged: environment.isPackaged,
      isDevelopment: environment.isDevelopment,
    });
    return null;
  }
  if (config.disableAutoUpdate) {
    return yield* reject(
      "T3CODE_DISABLE_AUTO_UPDATE",
      env.T3CODE_DISABLE_AUTO_UPDATE,
      "automatic updates are disabled",
    );
  }
  if (Option.isNone(config.appImagePath)) {
    return yield* reject("APPIMAGE", env.APPIMAGE, "staged updates require an AppImage");
  }

  const compiled = Option.liftThrowable(RegExp)(versionPattern);
  if (Option.isNone(compiled)) {
    return yield* reject(variables.versionPattern, rawPattern, "invalid regular expression");
  }
  const parseVersion = (version: string) => {
    const match = compiled.value.exec(version);
    if (match?.[0] !== version) return undefined;
    const [, base, build] = match;
    return base && build && dottedVersion.test(base) && dottedVersion.test(build)
      ? { base, build, version }
      : undefined;
  };
  const installed = parseVersion(environment.appVersion);
  if (!installed) {
    return yield* reject(
      variables.versionPattern,
      rawPattern,
      `expected two dotted numeric captures matching the app version ${environment.appVersion}`,
    );
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const app = yield* ElectronApp.ElectronApp;

  const readStagedBuild = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(pendingDirectory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as string[]),
      ),
    );
    const builds = entries.flatMap((name) => {
      const version = /^T3-Code-(.+)-x86_64\.AppImage$/.exec(name)?.[1];
      const parsed = version === undefined ? undefined : parseVersion(version);
      return parsed ? [{ name, ...parsed }] : [];
    });
    // The launcher sorts whole filenames: the upstream base precedes the fork version.
    builds.sort(
      (a, b) => compareForkVersions(a.base, b.base) || compareForkVersions(a.build, b.build),
    );
    const latest = builds.at(-1);
    if (!latest || compareForkVersions(latest.build, installed.build) <= 0) return null;
    const info = yield* fileSystem.stat(environment.path.join(pendingDirectory, latest.name));
    return info.type === "File" && info.size > 0 ? latest.version : null;
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
