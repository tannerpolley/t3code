import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { listLinkedPullRequestThreads } from "../pullRequest/linkedThreads.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { WorkflowForgeError } from "./WorkflowForge.ts";

export const WorktreeRemoval = Schema.Struct({
  removed: Schema.Boolean,
  kept: Schema.NullOr(Schema.String),
  localBranchDeleted: Schema.Boolean,
});

export class WorkflowThreads extends Context.Service<
  WorkflowThreads,
  {
    readonly linked: (
      pullRequest: ThreadPullRequestKey,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, WorkflowForgeError>;
    readonly archive: (
      threadId: ThreadId,
      commandId: string,
    ) => Effect.Effect<boolean, WorkflowForgeError>;
    readonly removeWorktree: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly branch: string;
      readonly headSha: string;
    }) => Effect.Effect<typeof WorktreeRemoval.Type, WorkflowForgeError>;
  }
>()("t3/workflows/WorkflowThreads") {}

const failed = (reason: string) => (cause: unknown) =>
  new WorkflowForgeError({
    reason: `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const vcs = yield* VcsProcess.VcsProcess;
  const folders = yield* TaskFolders.TaskFolders;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const runGit = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcs.run({
      operation: "WorkflowThreads.removeWorktree",
      command: "git",
      cwd,
      args,
      allowNonZeroExit,
    });

  const clean = Effect.fn("WorkflowThreads.inspectWorktree")(function* (path: string) {
    const status = yield* runGit(path, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    return status.stdout.length === 0 && !status.stdoutTruncated;
  });

  const removeWorktree: WorkflowThreads["Service"]["removeWorktree"] = Effect.fn(
    "WorkflowThreads.removeWorktree",
  )(
    function* ({ threadId, cwd, branch, headSha }) {
      const result = { removed: false, kept: null, localBranchDeleted: false };
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null || thread.deletedAt !== null) return result;
      const path = thread.worktreePath;
      if (thread.archivedAt === null || thread.branch !== branch || path === cwd) {
        return { ...result, kept: "The thread or its workspace changed." };
      }
      const ref = `refs/heads/${branch}`;
      const remove = Effect.gen(function* () {
        const current = yield* threads.getThreadShell(threadId);
        if (
          current?.archivedAt == null ||
          current.worktreePath !== path ||
          current.branch !== branch
        ) {
          return { ...result, kept: "The thread or its workspace changed." };
        }
        const tip = yield* runGit(cwd, ["rev-parse", "--verify", "--quiet", ref], true);
        if (tip.exitCode !== 0 && tip.exitCode !== 1) {
          return yield* new WorkflowForgeError({ reason: `Could not verify local ref ${ref}.` });
        }
        if (tip.exitCode === 0 && tip.stdout.trim() !== headSha) {
          return { ...result, kept: "The local branch has commits outside the merged PR head." };
        }
        const exists = path !== null && (yield* fs.exists(path));
        const folder = path === null ? null : yield* folders.find(path);
        if (folder !== null && folder.root !== path && folder.projectPath !== path) {
          return { ...result, kept: "The worktree is part of another task folder." };
        }
        if (path !== null && (exists || folder !== null)) {
          const owners = yield* projection.getThreadWorktreePaths();
          const root = folder?.root ?? path;
          if (
            owners.some((owner) => {
              if (owner.threadId === threadId) return false;
              const relative = paths.relative(root, owner.worktreePath);
              return (
                relative !== ".." &&
                !relative.startsWith(`..${paths.sep}`) &&
                !paths.isAbsolute(relative)
              );
            })
          ) {
            return { ...result, kept: "Another live thread uses this worktree." };
          }
          const checkouts =
            folder === null
              ? [path]
              : [
                  ...(folder.projectIsWorktree ? [folder.projectPath] : []),
                  ...folder.repositories.map((checkout) => checkout.worktreePath),
                ];
          for (const checkout of checkouts) {
            if (!(yield* fs.exists(checkout))) continue;
            if (!(yield* clean(checkout))) {
              return { ...result, kept: `The worktree at ${checkout} has local files or changes.` };
            }
            if (folder !== null) {
              const head = yield* runGit(checkout, ["symbolic-ref", "--quiet", "HEAD"], true);
              if (head.exitCode !== 0) {
                return { ...result, kept: `The worktree at ${checkout} is not on a local branch.` };
              }
            }
          }
          if (folder === null) {
            const head = yield* runGit(path, ["rev-parse", "HEAD"]);
            if (head.stdout.trim() !== headSha) {
              return { ...result, kept: "The worktree is no longer at the merged PR head." };
            }
            yield* git.removeWorktree({ cwd, path, force: false });
          } else {
            const removal = yield* folders.remove({
              root: folder.root,
              force: false,
              forget: true,
              projectCommands: "request-not-permitted",
            });
            if (removal.kept.length > 0) {
              return {
                ...result,
                removed: removal.removed.includes(path),
                kept: removal.kept.map((entry) => `${entry.path}: ${entry.reason}`).join(", "),
              };
            }
          }
        }
        if (tip.exitCode === 0) {
          const latestTip = yield* runGit(cwd, ["rev-parse", "--verify", ref]);
          if (latestTip.stdout.trim() !== headSha) {
            return {
              ...result,
              removed: exists,
              kept: "The local branch advanced during cleanup.",
            };
          }
          yield* git.deleteLocalBranch({ cwd, refName: branch, force: true });
        }
        return {
          ...result,
          removed: exists || folder !== null,
          localBranchDeleted: tip.exitCode === 0,
        };
      });
      return yield* path === null ? remove : withWorkspaceLease(path, remove);
    },
    Effect.mapError(failed("Could not remove the thread worktree")),
  );

  return WorkflowThreads.of({
    linked: Effect.fn("WorkflowThreads.linked")(
      function* (key) {
        const result = yield* listLinkedPullRequestThreads(key).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const shells = yield* Effect.forEach(result.threads, ({ id }) =>
          threads.getThreadShell(id),
        );
        return shells.flatMap((shell) => (shell?.deletedAt === null ? [shell] : []));
      },
      Effect.mapError(failed("Could not read pull request threads")),
    ),
    archive: Effect.fn("WorkflowThreads.archive")(
      function* (threadId, commandId) {
        const thread = yield* threads.getThreadShell(threadId);
        if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null)
          return false;
        if (thread.activeRunId !== null) {
          return yield* new WorkflowForgeError({
            reason: `Thread ${threadId} still has an active turn.`,
          });
        }
        yield* threads.dispatch({
          type: "thread.archive",
          threadId,
          commandId: CommandId.make(commandId),
        });
        return true;
      },
      Effect.mapError(failed("Could not archive the thread")),
    ),
    removeWorktree,
  });
});

export const layer = Layer.effect(WorkflowThreads, make);
