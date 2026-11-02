import {
  GitCommandError,
  PROJECT_LOCAL_WORKTREES,
  PROJECT_WORKTREES_FOLDER,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Semaphore from "effect/Semaphore";

import { resolveWorktreePath } from "./forkWorktreePaths.ts";

// ponytail: linear probe; past this many copies of one name, creation fails.
const UNIQUE_WORKTREE_NAME_ATTEMPTS = 100;

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

/** Resolves worktree folder names under the configured location; null means an invalid location. */
export const worktreeLocation = Effect.fn("GitVcsDriver.worktreeLocation")(function* (input: {
  readonly cwd: string;
  readonly setting: string | undefined;
  readonly worktreesDir: string;
  readonly path: Path.Path;
  readonly home: string;
  readonly repositoryRoot: Effect.Effect<string | undefined, GitCommandError>;
}) {
  const repositoryRoot =
    input.setting === PROJECT_LOCAL_WORKTREES ? yield* input.repositoryRoot : undefined;
  const resolve = (name: string) =>
    resolveWorktreePath(
      input.setting ?? "",
      input.worktreesDir,
      input.path,
      input.home,
      input.cwd,
      name,
      repositoryRoot,
    );
  return { repositoryRoot, resolve };
});

/** Places a validated worktree path; with `uniqueRefName`, also claims and adds it. */
export const placeWorktree = Effect.fn("GitVcsDriver.placeWorktree")(function* (input: {
  readonly cwd: string;
  readonly resolvedPath: string;
  readonly resolve: (name: string) => string | null;
  readonly repositoryRoot: string | undefined;
  readonly directoryName: string;
  readonly uniqueRefName: string | undefined;
  readonly suffixBranch: boolean;
  readonly repositoryPaths: Effect.Effect<
    { readonly gitCommonDir: string } | null,
    GitCommandError
  >;
  readonly semaphore: Semaphore.Semaphore;
  readonly addWorktree: (target: string, branch: string) => Effect.Effect<unknown, GitCommandError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { resolvedPath, resolve, repositoryRoot } = input;
  if (repositoryRoot !== undefined) {
    const repository = yield* input.repositoryPaths;
    if (repository !== null)
      yield* input.semaphore.withPermits(1)(
        excludeProjectWorktrees(input.cwd, repository.gitCommonDir, repositoryRoot),
      );
  }
  if (input.uniqueRefName === undefined) return { worktreePath: resolvedPath };
  // Each attempt is the creation itself, so concurrent requests cannot
  // both pass a check and then collide: the folder is claimed with an
  // atomic mkdir (Git accepts an empty folder), and Git's own refusal of
  // a taken branch or ref namespace moves on to the next suffix.
  const baseDirectory = input.directoryName;
  const baseRefName = input.uniqueRefName;
  const suffixBranch = input.suffixBranch;
  const fileSystemError = (detail: string) => (cause: PlatformError.PlatformError) =>
    new GitCommandError({
      operation: "GitVcsDriver.createWorktree",
      command: "git worktree add",
      cwd: input.cwd,
      detail,
      cause,
    });
  yield* fileSystem
    .makeDirectory(path.dirname(resolvedPath), { recursive: true })
    .pipe(Effect.mapError(fileSystemError("Failed to create the worktrees folder.")));
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > UNIQUE_WORKTREE_NAME_ATTEMPTS)
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "git worktree add",
        cwd: input.cwd,
        detail: `Could not find a free worktree name for '${baseDirectory}'.`,
      });
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidatePath = resolve(`${baseDirectory}${suffix}`)!;
    const candidateRef = suffixBranch ? `${baseRefName}${suffix}` : baseRefName;
    const claimed = yield* fileSystem.makeDirectory(candidatePath).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
      Effect.mapError(fileSystemError("Failed to create the worktree folder.")),
    );
    if (!claimed) continue;
    const added = yield* input.addWorktree(candidatePath, candidateRef).pipe(
      Effect.as(true),
      // The folder is this attempt's own, so a failed add releases it.
      Effect.onError(() =>
        fileSystem.remove(candidatePath, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
      Effect.catchIf(
        (error) =>
          suffixBranch &&
          (error.reason === "branch_already_exists" || error.reason === "ref_name_conflict"),
        () => Effect.succeed(false),
      ),
    );
    if (added) return { worktreePath: candidatePath, claimedRefName: candidateRef };
  }
});
