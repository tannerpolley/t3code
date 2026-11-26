// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture runs Git in a temporary repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as WorkflowThreads from "./WorkflowThreads.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => exec("git", args, { cwd, encoding: "utf8" }));

it.live.each(["clean", "dirty"] as const)(
  "archives the child and handles a %s worktree",
  (status) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-cleanup-" });
      const worktreePath = path.join(cwd, "child");
      const threadId = ThreadId.make("child");
      const branch = "fixture-branch";
      yield* git(cwd, "init", "-b", "main");
      yield* git(
        cwd,
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "user.name=Fixture",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      yield* git(cwd, "worktree", "add", "-b", branch, worktreePath);
      const headSha = (yield* git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
      if (status === "dirty")
        yield* fs.writeFileString(path.join(worktreePath, "keep.txt"), "uncommitted");
      let archivedAt: DateTime.Utc | null = null;
      const dependencies = Layer.mergeAll(
        Sqlite.layerMemory,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.sync(
              () =>
                ({
                  id: threadId,
                  archivedAt,
                  branch,
                  worktreePath,
                  deletedAt: null,
                  activeRunId: null,
                }) as OrchestrationV2ThreadShell,
            ),
          dispatch: (command) =>
            Effect.gen(function* () {
              assert.equal(command.type, "thread.archive");
              assert.propertyVal(command, "threadId", threadId);
              archivedAt = yield* DateTime.now;
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () => Effect.succeed([]),
        }),
        Layer.mock(TaskFolders.TaskFolders)({ find: () => Effect.succeed(null) }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: ({ cwd, args }) =>
            git(cwd, ...args).pipe(
              Effect.map((output) => ({
                ...output,
                exitCode: 0 as never,
                stdoutTruncated: false,
                stderrTruncated: false,
              })),
            ),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          removeWorktree: ({ cwd, path, force }) =>
            git(cwd, "worktree", "remove", ...(force ? ["--force"] : []), path).pipe(Effect.asVoid),
          deleteLocalBranch: ({ cwd, refName, force }) =>
            git(cwd, "branch", force ? "-D" : "-d", "--", refName).pipe(Effect.asVoid),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* WorkflowThreads.WorkflowThreads;
        assert.isTrue(yield* service.archive(threadId, "fixture:archive"));
        const removal = yield* service.removeWorktree({ threadId, cwd, branch, headSha });
        const ref = (yield* git(
          cwd,
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${branch}`,
        )).stdout.trim();
        if (status === "dirty") {
          assert.include(removal.kept, "has local files or changes");
          assert.equal(ref, `refs/heads/${branch}`);
          assert.equal(
            yield* fs.readFileString(path.join(worktreePath, "keep.txt")),
            "uncommitted",
          );
        } else {
          assert.deepEqual(removal, { removed: true, kept: null, localBranchDeleted: true });
          assert.equal(ref, "");
          assert.isFalse(yield* fs.exists(worktreePath));
        }
      }).pipe(Effect.provide(WorkflowThreads.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(NodeServices.layer)),
);
