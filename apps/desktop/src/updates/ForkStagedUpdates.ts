// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem.access has no execute permission check.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

class ForkStagedUpdateChangedError extends Schema.TaggedError<ForkStagedUpdateChangedError>()(
  "ForkStagedUpdateChangedError",
  {},
) {}

class ForkLauncherNotExecutableError extends Schema.TaggedError<ForkLauncherNotExecutableError>()(
  "ForkLauncherNotExecutableError",
  { launcher: Schema.String },
) {
  override get message() {
    return `The staged update launcher is not executable: ${this.launcher}`;
  }
}

const dottedVersion = /^\d+(?:\.\d+)*$/;
const { logWarning } = makeComponentLogger("desktop-fork-staged-updates");

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (const [index, part] of a.entries()) {
    const other = b[index];
    if (other === undefined || part > other) return 1;
    if (part < other) return -1;
  }
  return a.length - b.length;
}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const { path } = environment;
  const directory = Option.getOrUndefined(config.stagedUpdateDirectory)?.trim();
  const pattern = Option.getOrUndefined(config.stagedUpdateVersionPattern)?.trim();
  if (directory === undefined && pattern === undefined) return undefined;

  const launcher = Option.getOrUndefined(environment.desktopLauncherPath);
  const compiled = pattern
    ? Option.getOrUndefined(Option.liftThrowable(RegExp)(pattern))
    : undefined;
  const parseVersion = (version: string) => {
    const match = compiled?.exec(version);
    const [full, base, release] = match ?? [];
    return full === version &&
      base &&
      release &&
      dottedVersion.test(base) &&
      dottedVersion.test(release)
      ? { version, base, release }
      : undefined;
  };
  const installed = parseVersion(environment.appVersion);
  if (
    !directory ||
    !path.isAbsolute(directory) ||
    !launcher ||
    !path.isAbsolute(launcher) ||
    !installed
  ) {
    yield* logWarning("invalid staged update launcher configuration", {
      directory,
      launcher,
      pattern,
    });
    return null;
  }
  if (
    environment.platform !== "linux" ||
    environment.processArch !== "x64" ||
    Option.isNone(config.appImagePath)
  ) {
    return null;
  }

  const fs = yield* FileSystem.FileSystem;
  const app = yield* ElectronApp.ElectronApp;

  const detect = Effect.fn("desktop.forkStagedUpdates.detect")(
    function* () {
      const entries = yield* fs.readDirectory(directory);
      const builds = [];
      for (const name of entries) {
        if (!name.startsWith("T3-Code-") || !name.endsWith(".AppImage")) continue;
        const match = /^T3-Code-(.+)-x86_64\.AppImage$/.exec(name);
        const build = match?.[1] === undefined ? undefined : parseVersion(match[1]);
        // The launcher passes this wider glob to ls, which also lists any matching directories.
        if (!build) return null;
        const info = yield* fs.stat(path.join(directory, name));
        if (info.type !== "File") return null;
        builds.push({ ...build, name, size: info.size });
      }
      // The launcher uses sort -V on the full filename, with the upstream version first.
      const latest = builds
        .sort(
          (a, b) =>
            compareVersions(a.base, b.base) ||
            compareVersions(a.release, b.release) ||
            a.name.localeCompare(b.name),
        )
        .at(-1);
      return latest && latest.size > 0 && compareVersions(latest.release, installed.release) > 0
        ? latest.version
        : null;
    },
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );

  return {
    detect,
    install: Effect.fn("desktop.forkStagedUpdates.install")(function* (
      expectedVersion: string | null,
    ) {
      const version = yield* detect();
      if (version === null || version !== expectedVersion)
        return yield* new ForkStagedUpdateChangedError();
      const notExecutable = () => new ForkLauncherNotExecutableError({ launcher });
      const info = yield* fs.stat(launcher).pipe(Effect.mapError(notExecutable));
      if (info.type !== "File") return yield* notExecutable();
      yield* Effect.tryPromise({
        try: () => NodeFSP.access(launcher, NodeFSP.constants.X_OK),
        catch: notExecutable,
      });
      yield* app
        .relaunch({
          execPath: launcher,
          args: ["--update-from-pid", String(process.pid)],
        })
        .pipe(Effect.andThen(app.quit), Effect.uninterruptible);
    }),
  };
});
