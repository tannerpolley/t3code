// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.

import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, it, describe } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as Scope from "effect/Scope";

import { GitCommandError, PROJECT_LOCAL_WORKTREES } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";

import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("resolveDefaultBranchRef", () => {
    it.effect.each(["main", "master"])(
      "resolves local %s without a remote HEAD from a feature branch",
      (branch) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["branch", "-M", branch]);
          yield* git(cwd, ["remote", "add", "origin", cwd]);
          yield* git(cwd, ["checkout", "-b", "worker"]);
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const ref = yield* driver.resolveDefaultBranchRef(cwd);

          assert.equal(ref, branch);
          assert.equal(
            yield* git(cwd, ["rev-parse", `${ref}^{commit}`]),
            yield* git(cwd, ["rev-parse", branch]),
          );
        }),
    );

    it.effect.each([
      { remote: "origin", branch: "main", remoteHead: false },
      { remote: "origin", branch: "master", remoteHead: false },
      { remote: "origin", branch: "trunk", remoteHead: true },
      { remote: "upstream", branch: "trunk", remoteHead: true },
    ])("resolves a remote-only default: %j", ({ remote, branch, remoteHead }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "worker"]);
        yield* git(cwd, ["remote", "add", remote, cwd]);
        yield* git(cwd, ["update-ref", `refs/remotes/${remote}/${branch}`, "HEAD"]);
        if (remoteHead) {
          yield* git(cwd, [
            "symbolic-ref",
            `refs/remotes/${remote}/HEAD`,
            `refs/remotes/${remote}/${branch}`,
          ]);
        }
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const ref = yield* driver.resolveDefaultBranchRef(cwd);

        assert.equal(ref, `${remote}/${branch}`);
        assert.equal(
          yield* git(cwd, ["rev-parse", `${ref}^{commit}`]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    );

    it.effect("prefers the local default over its remote copy and main/master fallbacks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["branch", "trunk"]);
        yield* git(cwd, ["checkout", "-b", "worker"]);
        yield* git(cwd, ["remote", "add", "origin", cwd]);
        yield* git(cwd, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.equal(yield* driver.resolveDefaultBranchRef(cwd), "trunk");
      }),
    );

    it.effect("falls back to local master when remote HEAD points to a missing default", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "master"]);
        yield* git(cwd, ["checkout", "-b", "worker"]);
        yield* git(cwd, ["remote", "add", "origin", cwd]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.equal(yield* driver.resolveDefaultBranchRef(cwd), "master");
      }),
    );

    it.effect("fails instead of using the current feature branch or a main tag", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "worker"]);
        yield* git(cwd, ["tag", "main"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver.resolveDefaultBranchRef(cwd).pipe(Effect.flip);

        assert.equal(error._tag, "GitCommandError");
        assert.equal(error.operation, "GitVcsDriver.resolveDefaultBranchRef");
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect(
      "creates project-local worktrees from subfolders and linked checkouts and excludes them once",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const subfolder = path.join(cwd, "finance");
          yield* fs.makeDirectory(subfolder);
          const exclude = path.join(cwd, ".git", "info", "exclude");
          yield* fs.writeFileString(exclude, "# preserve existing rules\nlocal.txt");
          const create = (cwd: string, branch: string) =>
            driver.createWorktree(
              { cwd, path: null, refName: initialBranch, newRefName: branch },
              { worktreesDirectory: PROJECT_LOCAL_WORKTREES },
            );
          const first = yield* create(subfolder, "feature/finance");
          assert.equal(first.worktree.path, path.join(cwd, ".worktrees", "feature-finance"));
          const second = yield* create(first.worktree.path, "feature/child");
          assert.equal(second.worktree.path, path.join(cwd, ".worktrees", "feature-child"));
          assert.equal(
            yield* fs.readFileString(exclude),
            "# preserve existing rules\nlocal.txt\n.worktrees/\n",
          );
          assert.equal(yield* fs.readFileString(path.join(cwd, ".worktrees", ".ignore")), "/*\n");
          assert.equal(yield* fs.exists(path.join(cwd, ".gitignore")), false);
          assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
        }),
    );

    it.effect("suffixes a unique worktree name past taken branches, folders and namespaces", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const local = path.join(cwd, ".worktrees");
        const create = (newRefName: string, directoryName?: string) =>
          driver.createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName },
            {
              worktreesDirectory: PROJECT_LOCAL_WORKTREES,
              uniqueName: true,
              ...(directoryName ? { directoryName } : {}),
            },
          );
        const refNames = (results: ReadonlyArray<{ worktree: { refName: string } }>) =>
          results.map((result) => result.worktree.refName).toSorted();

        // A taken branch, a stray folder, and a ref namespace each move to the next suffix.
        yield* git(cwd, ["branch", "issue-7-fix"]);
        yield* fs.makeDirectory(path.join(local, "issue-7-fix-2"), { recursive: true });
        yield* fs.writeFileString(path.join(local, "issue-7-fix-2", "keep"), "");
        const created = yield* create("issue-7-fix");
        assert.equal(created.worktree.refName, "issue-7-fix-3");
        assert.equal(created.worktree.path, path.join(local, "issue-7-fix-3"));
        yield* git(cwd, ["branch", "parser/old"]);
        assert.equal((yield* create("parser")).worktree.refName, "parser-2");

        // Concurrent requests for one name all succeed under distinct suffixes.
        const same = yield* Effect.all(
          Array.from({ length: 4 }, () => create("same-title")),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(refNames(same), [
          "same-title",
          "same-title-2",
          "same-title-3",
          "same-title-4",
        ]);

        // Temporary branches sharing a folder name keep their branches; only folders move.
        const temporary = yield* Effect.all(
          [create("t3/aaaaaaaa", "new-thread"), create("t3/bbbbbbbb", "new-thread")],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(refNames(temporary), ["t3/aaaaaaaa", "t3/bbbbbbbb"]);
        assert.deepEqual(
          temporary.map((result) => path.basename(result.worktree.path)).toSorted(),
          ["new-thread", "new-thread-2"],
        );
      }),
    );
  });
});
