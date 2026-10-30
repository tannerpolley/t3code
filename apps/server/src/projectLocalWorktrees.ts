import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Semaphore from "effect/Semaphore";
import { resolveWorktreePath } from "./worktreesDirectory.ts";
import {
  GitCommandError,
  PROJECT_LOCAL_WORKTREES,
  PROJECT_WORKTREES_FOLDER,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Preparation inside the Git driver's worktree-creation operation. */
const excludeProjectWorktrees = Effect.fn("GitVcsDriver.excludeProjectWorktrees")(function* (
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
      // fff's native index/watcher reads .ignore but not .git/info/exclude. Anchored, so ripgrep
      // run inside a worktree (which reads parent .ignore files) still searches that checkout.
      appendRule(path.join(repositoryRoot, PROJECT_WORKTREES_FOLDER, ".ignore"), "/*"),
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

export const prepareWorktreeLocation = Effect.fn("GitVcsDriver.prepareWorktreeLocation")(
  function* (input: {
    readonly cwd: string;
    readonly setting: string | undefined;
    readonly worktreesDir: string;
    readonly directoryName: string;
    readonly repositoryRoot: Effect.Effect<string | undefined, GitCommandError>;
    readonly repositoryPaths: Effect.Effect<
      { readonly gitCommonDir: string } | null,
      GitCommandError
    >;
    readonly semaphore: Semaphore.Semaphore;
  }) {
    const path = yield* Path.Path;
    const repositoryRoot =
      input.setting === PROJECT_LOCAL_WORKTREES ? yield* input.repositoryRoot : undefined;
    const home = yield* HostProcess.HomeDirectory;
    const resolve = (name: string) =>
      resolveWorktreePath(
        input.setting ?? "",
        input.worktreesDir,
        path,
        home,
        input.cwd,
        name,
        repositoryRoot,
      );
    if (resolve(input.directoryName) === null)
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "git worktree add",
        cwd: input.cwd,
        detail: `The worktree location "${input.setting}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      });
    if (repositoryRoot !== undefined) {
      const repository = yield* input.repositoryPaths;
      if (repository !== null)
        yield* input.semaphore.withPermits(1)(
          excludeProjectWorktrees(input.cwd, repository.gitCommonDir, repositoryRoot),
        );
    }
    return resolve;
  },
);
