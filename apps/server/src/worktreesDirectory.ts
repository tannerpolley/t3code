import type * as Path from "effect/Path";
import { PROJECT_LOCAL_WORKTREES, PROJECT_WORKTREES_FOLDER } from "@t3tools/contracts";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting (`~` expands to `home`), or `defaultDir` (`<T3 home>/worktrees`)
 * when it is empty. Project-local mode uses `repositoryRoot/.worktrees`. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
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
    : path.join(directory, path.basename(cwd), folder);
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
