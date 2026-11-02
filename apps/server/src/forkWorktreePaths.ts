import { PROJECT_LOCAL_WORKTREES, PROJECT_WORKTREES_FOLDER } from "@t3tools/contracts";
import type * as Path from "effect/Path";

import { resolveWorktreesDirectory } from "./worktreesDirectory.ts";

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
  const folder = name.replaceAll("/", "-");
  if (setting === PROJECT_LOCAL_WORKTREES)
    return repositoryRoot === undefined
      ? null
      : path.join(repositoryRoot, PROJECT_WORKTREES_FOLDER, folder);
  const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
  return directory === null ? null : path.join(directory, path.basename(path.resolve(cwd)), folder);
}

/** Exclude nested worktree trees from T3-controlled workspace scans. */
export function isProjectLocalWorktreePath(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").includes(PROJECT_WORKTREES_FOLDER);
}
