import { IssueCleanupError, type IssueCleanupInput } from "@t3tools/contracts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";

export class IssueCleanup extends Context.Service<
  IssueCleanup,
  {
    readonly cleanup: (input: IssueCleanupInput) => Effect.Effect<void, IssueCleanupError>;
  }
>()("t3/issues/IssueCleanup") {}

const unavailable = (cause: unknown) => new IssueCleanupError({ code: "unavailable", cause });

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const roadmap = yield* IssueRoadmap.IssueRoadmap;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const github = yield* GitHubPullRequestApi.GitHubPullRequestApi;

  const cleanup = Effect.fn("IssueCleanup.cleanup")(function* (input: IssueCleanupInput) {
    if (!input.confirmed) return yield* new IssueCleanupError({ code: "confirmation-required" });
    const detail = yield* roadmap.detail(input).pipe(Effect.mapError(unavailable));
    if (detail.issue.state !== "closed")
      return yield* new IssueCleanupError({ code: "not-closed" });
    const work = detail.issue.liveWork?.find((work) => work.threadId === input.threadId);
    const thread = yield* projections
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(unavailable));
    if (
      !work ||
      !thread ||
      thread.deletedAt !== null ||
      thread.branch !== input.expectedBranch ||
      thread.worktreePath !== input.expectedWorktreePath
    )
      return yield* new IssueCleanupError({ code: "work-changed" });
    if (work.status !== "idle" || (thread.archivedAt === null && thread.activeRunId !== null))
      return yield* new IssueCleanupError({ code: "work-active" });
    const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* new IssueCleanupError({ code: "unavailable" });
    const cwd = project.value.workspaceRoot;

    if (input.action === "remove-worktree") {
      if (!thread.worktreePath) return yield* new IssueCleanupError({ code: "work-changed" });
      const paths = yield* git.listWorktreePaths(cwd).pipe(Effect.mapError(unavailable));
      const target = path.resolve(thread.worktreePath);
      if (paths[0] === target || path.resolve(cwd) === target)
        return yield* new IssueCleanupError({ code: "main-worktree" });
      if (!paths.includes(target)) return yield* new IssueCleanupError({ code: "work-changed" });
      const status = yield* git
        .execute({
          cwd: target,
          operation: "IssueCleanup.worktreeStatus",
          args: ["status", "--porcelain=v1", "--untracked-files=all"],
        })
        .pipe(Effect.mapError(unavailable));
      if (status.stdout.length > 0 || status.stdoutTruncated)
        return yield* new IssueCleanupError({ code: "dirty-worktree" });
      // Never force: Git rechecks dirtiness and worktree locks at the point of removal.
      return yield* git
        .removeWorktree({ cwd, path: target, force: false })
        .pipe(Effect.mapError(unavailable));
    }

    const branch = thread.branch;
    if (!branch || branch.startsWith("-"))
      return yield* new IssueCleanupError({ code: "work-changed" });
    const worktrees = yield* git
      .execute({
        cwd,
        operation: "IssueCleanup.branchWorktrees",
        args: ["worktree", "list", "--porcelain", "-z"],
      })
      .pipe(Effect.mapError(unavailable));
    if (worktrees.stdoutTruncated) return yield* new IssueCleanupError({ code: "unavailable" });
    if (worktrees.stdout.split("\0").includes(`branch refs/heads/${branch}`))
      return yield* new IssueCleanupError({ code: "checked-out" });
    const head = yield* git
      .execute({
        cwd,
        operation: "IssueCleanup.branchHead",
        args: ["rev-parse", "--verify", `refs/heads/${branch}`],
      })
      .pipe(Effect.mapError(unavailable));
    if (!input.confirmUnmerged) {
      let merged = false;
      for (const pr of detail.issue.pullRequests ?? []) {
        const fresh = yield* github
          .getPullRequestDetail({
            cwd,
            host: pr.host,
            repository: pr.repository,
            number: pr.number,
          })
          .pipe(Effect.mapError(unavailable));
        if (fresh.state !== "merged" || fresh.headBranch !== branch || !fresh.headSha) continue;
        const contained = yield* git
          .execute({
            cwd,
            operation: "IssueCleanup.verifyMergedHead",
            args: ["merge-base", "--is-ancestor", head.stdout.trim(), fresh.headSha],
            allowNonZeroExit: true,
          })
          .pipe(Effect.mapError(unavailable));
        if (contained.exitCode === 0) {
          merged = true;
          break;
        }
      }
      if (!merged) return yield* new IssueCleanupError({ code: "unmerged" });
    }
    // Recheck the head before deletion. Git refuses checked-out branches even with -D,
    // which is needed for squash-merged PRs whose commits are not ancestors of the default branch.
    const current = yield* git
      .execute({
        cwd,
        operation: "IssueCleanup.recheckBranchHead",
        args: ["rev-parse", "--verify", `refs/heads/${branch}`],
      })
      .pipe(Effect.mapError(unavailable));
    if (current.stdout !== head.stdout)
      return yield* new IssueCleanupError({ code: "work-changed" });
    yield* git
      .deleteLocalBranch({ cwd, refName: branch, force: true })
      .pipe(Effect.mapError(unavailable));
  });
  return IssueCleanup.of({ cleanup });
});

export const layer = Layer.effect(IssueCleanup, make);
