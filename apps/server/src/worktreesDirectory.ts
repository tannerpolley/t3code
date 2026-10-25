import { PROJECT_LOCAL_WORKTREES, PROJECT_WORKTREES_FOLDER } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

/** Null for filesystem roots or settings not absolute on this host, including synced foreign-platform paths. */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
  repositoryRoot?: string,
): string | null {
  if (setting === PROJECT_LOCAL_WORKTREES)
    return repositoryRoot === undefined
      ? null
      : path.join(repositoryRoot, PROJECT_WORKTREES_FOLDER);
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** One naming policy for ordinary and detached worktree creation. */
export function resolveWorktreePath(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
  cwd: string,
  name: string,
  repositoryRoot?: string,
): string | null {
  const directory = resolveWorktreesDirectory(setting, defaultDir, path, home, repositoryRoot);
  if (directory === null) return null;
  const folder = name.replaceAll("/", "-");
  return setting === PROJECT_LOCAL_WORKTREES
    ? path.join(directory, folder)
    : path.join(directory, path.basename(path.resolve(cwd)), folder);
}

/** Exclude nested worktree trees from T3-controlled workspace scans. */
export function isProjectLocalWorktreePath(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").includes(PROJECT_WORKTREES_FOLDER);
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
  repositoryRoots: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  // Keep local worktrees managed after switching back to a home or custom folder.
  for (const root of repositoryRoots) directories.add(path.join(root, PROJECT_WORKTREES_FOLDER));
  return [...directories];
}

// Client paths/branches are untrusted; recreate only real paths matching managed-folder/repo/branch.
export const makeIsManagedWorktreePath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  // Match Git's symlink-following location: nearest real ancestor plus missing path components.
  const realLocation = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  return Effect.fn("worktreesDirectory.isManagedWorktreePath")(function* (worktreePath: string) {
    // git resolves a relative path against the project, not the server cwd.
    if (!path.isAbsolute(worktreePath)) return false;
    // Require normalized paths; Git and realPath disagree on .. after symlink traversal.
    if (path.resolve(worktreePath) !== worktreePath) return false;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({
        worktreesDirectory: "",
        previousWorktreesDirectories: [],
      })),
    );
    const roots = yield* Effect.forEach(
      managedWorktreesDirectories(
        settings,
        serverConfig.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      ),
      realLocation,
    );
    const candidate = yield* realLocation(worktreePath);
    return roots.some((root) => {
      if (isFilesystemRoot(root, path)) return false;
      const relative = path.relative(root, candidate);
      const segments = relative.split(path.sep);
      return (
        !path.isAbsolute(relative) &&
        segments.length === 2 &&
        segments.every((segment) => segment !== "" && segment !== "..")
      );
    });
  });
});
