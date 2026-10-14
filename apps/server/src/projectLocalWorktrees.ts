import { GitCommandError, PROJECT_WORKTREES_FOLDER } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Preparation inside the Git driver's worktree-creation operation. */
export const excludeProjectWorktrees = Effect.fn("GitVcsDriver.excludeProjectWorktrees")(function* (
  cwd: string,
  gitCommonDir: string,
  repositoryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appendRule = Effect.fnUntraced(function* (filePath: string, rule: string) {
    const contents = yield* fs.readFileString(filePath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      }),
    );
    if (contents.split(/\r?\n/).some((line) => line.trim() === rule || line.trim() === `/${rule}`))
      return;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      `${contents && !contents.endsWith("\n") ? "\n" : ""}${rule}\n`,
      { flag: "a" },
    );
  });
  yield* appendRule(
    path.join(gitCommonDir, "info", "exclude"),
    `${PROJECT_WORKTREES_FOLDER}/`,
  ).pipe(
    Effect.andThen(
      // fff's native index/watcher reads .ignore but not .git/info/exclude.
      appendRule(path.join(repositoryRoot, PROJECT_WORKTREES_FOLDER, ".ignore"), "*"),
    ),
    Effect.mapError(
      (cause) =>
        new GitCommandError({
          operation: "GitVcsDriver.excludeProjectWorktrees",
          command: "git worktree add",
          cwd,
          detail: "Failed to exclude project-local worktrees from the repository.",
          cause,
        }),
    ),
  );
});
