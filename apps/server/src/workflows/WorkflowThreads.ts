import {
  CommandId,
  isDelegatedAppThread,
  type PullRequestDetail,
  type PullRequestRef,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { listLinkedPullRequestThreads } from "../pullRequest/linkedThreads.ts";
import { threadPullRequestKeysEqual } from "../sourceControl/threadPullRequests.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { WorkflowForgeError } from "./WorkflowForge.ts";

type MergedHead = ThreadPullRequestKey &
  Pick<PullRequestRef, "projectId"> &
  Pick<PullRequestDetail, "workspaceRoot" | "headBranch" | "baseBranch" | "headSha" | "url">;

export class WorkflowThreads extends Context.Service<
  WorkflowThreads,
  {
    readonly cleanUpCreator: (head: MergedHead) => Effect.Effect<string | null, WorkflowForgeError>;
  }
>()("t3/workflows/WorkflowThreads") {}

export const layer = Layer.effect(
  WorkflowThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const git = yield* GitWorkflow.GitWorkflowService;
    const vcs = yield* VcsProcess.VcsProcess;
    const fs = yield* FileSystem.FileSystem;

    const cleanUpCreator = Effect.fn("WorkflowThreads.cleanUpCreator")(
      function* (head: MergedHead) {
        const linked = yield* listLinkedPullRequestThreads(head).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const candidates = yield* Effect.forEach(linked.threads, ({ id }) =>
          threads.getThreadShell(id),
        );
        const creators = candidates.flatMap((thread) =>
          thread?.deletedAt === null &&
          thread.projectId === head.projectId &&
          isDelegatedAppThread(thread) &&
          thread.lineage.sideChat !== true &&
          thread.pullRequests?.some(
            (pr) => pr.source === "created" && threadPullRequestKeysEqual(pr, head),
          )
            ? [thread]
            : [],
        );
        let creator = creators.length === 1 ? creators[0] : null;
        while (creator?.deletedAt === null && creator.activeRunId !== null) {
          yield* threads.waitForThread({
            threadId: creator.id,
            projectId: creator.projectId,
            runId: creator.activeRunId,
            timeoutMs: 30_000,
          });
          creator = yield* threads.getThreadShell(creator.id);
        }
        if (creator?.deletedAt !== null) return null;
        const { id, worktreePath: path } = creator;
        if (creator.archivedAt === null) {
          yield* threads.dispatch({
            type: "thread.archive",
            threadId: id,
            commandId: CommandId.make(`workflow:merge-cleanup:${head.url}:${id}`),
          });
        }
        if (path === null) return "Creator archived.";
        return yield* withWorkspaceLease(
          path,
          Effect.gen(function* () {
            if (!(yield* fs.exists(path))) return "Creator archived. Worktree already absent.";
            const current = yield* threads.getThreadShell(id);
            if (
              current?.archivedAt == null ||
              current.worktreePath !== path ||
              current.branch !== head.headBranch ||
              head.headSha === undefined ||
              head.headBranch === head.baseBranch ||
              path === head.workspaceRoot
            ) {
              return "Kept worktree because its owner or expected head changed.";
            }
            const occupied = yield* projection.getThreadWorktreePaths();
            if (occupied.some((thread) => thread.threadId !== id && thread.worktreePath === path)) {
              return "Kept worktree because another live thread uses it.";
            }
            const status = yield* vcs.run({
              operation: "WorkflowThreads.cleanUpCreator",
              command: "git",
              cwd: path,
              args: [
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
                "--ignored=matching",
              ],
              allowNonZeroExit: true,
            });
            if (status.exitCode !== 0 || status.stdoutTruncated)
              return "Kept worktree because Git could not inspect it.";
            const lines = status.stdout.trimEnd().split("\n");
            if (lines.some((line) => !line.startsWith("# ")))
              return "Kept worktree with local files or changes.";
            if (
              !lines.includes(`# branch.oid ${head.headSha}`) ||
              !lines.includes(`# branch.head ${head.headBranch}`)
            ) {
              return "Kept worktree because its branch or commit changed.";
            }
            yield* git.removeWorktree({ cwd: head.workspaceRoot, path, force: false });
            return "Creator archived and worktree removed.";
          }),
        );
      },
      Effect.mapError(
        (cause) =>
          new WorkflowForgeError({ reason: `Could not clean up PR creator: ${cause.message}` }),
      ),
    );
    return WorkflowThreads.of({ cleanUpCreator });
  }),
);
