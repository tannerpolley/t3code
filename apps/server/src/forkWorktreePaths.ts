import { PROJECT_LOCAL_WORKTREES, PROJECT_WORKTREES_FOLDER } from "@t3tools/contracts";
import type * as Path from "effect/Path";

export function projectLocalWorktreesDirectory(
  setting: string,
  path: Path.Path,
  repositoryRoot?: string,
) {
  return setting === PROJECT_LOCAL_WORKTREES
    ? repositoryRoot === undefined
      ? null
      : path.join(repositoryRoot, PROJECT_WORKTREES_FOLDER)
    : undefined;
}

export function isProjectLocalWorktreePath(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").includes(PROJECT_WORKTREES_FOLDER);
}

export function projectLocalWorktreeRoots(repositoryRoots: ReadonlyArray<string>, path: Path.Path) {
  return repositoryRoots.map((root) => path.join(root, PROJECT_WORKTREES_FOLDER));
}
