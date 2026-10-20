import { IssueCleanupError, type IssueCleanupInput } from "@t3tools/contracts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import { storageCleanupThreadIdle } from "../storageCleanup.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
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
  const fs = yield* FileSystem.FileSystem;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
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
      const target = yield* fs.realPath(thread.worktreePath).pipe(Effect.mapError(unavailable));
      const root = yield* fs.realPath(cwd).pipe(Effect.mapError(unavailable));
      const registered = yield* Effect.forEach(paths, (entry) =>
        fs.realPath(entry).pipe(Effect.mapError(unavailable)),
      );
      if (registered[0] === target || root === target)
        return yield* new IssueCleanupError({ code: "main-worktree" });
      if (!registered.includes(target))
        return yield* new IssueCleanupError({ code: "work-changed" });
      const managedRoot = yield* fs
        .realPath(path.join(cwd, ".worktrees"))
        .pipe(Effect.mapError(unavailable));
      const relative = path.relative(managedRoot, target);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return yield* new IssueCleanupError({ code: "work-changed" });
      const status = yield* git
        .execute({
          cwd: target,
          operation: "IssueCleanup.worktreeStatus",
          args: ["status", "--porcelain=v1", "--untracked-files=all"],
        })
        .pipe(Effect.mapError(unavailable));
      if (status.stdout.length > 0 || status.stdoutTruncated)
        return yield* new IssueCleanupError({ code: "dirty-worktree" });
      const snapshot = yield* projections.getShellSnapshot().pipe(Effect.mapError(unavailable));
      const allProjects = yield* projects
        .list({ includeDeleted: true })
        .pipe(Effect.mapError(unavailable));
      const now = yield* Clock.currentTimeMillis;
      for (const candidate of [...snapshot.threads, ...snapshot.archivedThreads]) {
        const workspace =
          candidate.worktreePath ??
          allProjects.find((project) => project.projectId === candidate.projectId)?.workspaceRoot;
        if (!workspace) return yield* new IssueCleanupError({ code: "unavailable" });
        const realWorkspace = yield* fs.realPath(workspace).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(null)
                : Effect.fail(unavailable(error)),
          }),
        );
        if (realWorkspace !== target) continue;
        if (
          !storageCleanupThreadIdle({ ...candidate, worktreePath: workspace }, now) ||
          candidate.activityRunStatus != null
        )
          return yield* new IssueCleanupError({ code: "work-active" });
        const records = yield* projections
          .getThreadRecords(candidate.id, ["providerSessions"])
          .pipe(Effect.mapError(unavailable));
        for (const session of records.providerSessions) {
          if (yield* sessions.isLive(session.id))
            return yield* new IssueCleanupError({ code: "work-active" });
        }
      }
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
      const remote = yield* git
        .resolvePrimaryRemoteName(cwd)
        .pipe(Effect.orElseSucceed(() => null));
      const defaultBranch =
        remote === null
          ? yield* git.resolveDefaultBranchRef(cwd).pipe(Effect.mapError(unavailable))
          : ((yield* git
              .resolveDefaultBranchName(cwd, remote)
              .pipe(Effect.mapError(unavailable))) ??
            (yield* git
              .execute({
                cwd,
                operation: "IssueCleanup.defaultBranch",
                args: ["ls-remote", "--symref", "--", remote, "HEAD"],
              })
              .pipe(
                Effect.map(
                  (result) => /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
                ),
                Effect.mapError(unavailable),
              )));
      if (!defaultBranch) return yield* new IssueCleanupError({ code: "unmerged" });
      let merged = false;
      const refs = [`refs/heads/${defaultBranch}`];
      if (remote !== null) {
        yield* git
          .fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: defaultBranch })
          .pipe(Effect.mapError(unavailable));
        refs.push(`refs/remotes/${remote}/${defaultBranch}`);
      }
      for (const ref of refs) {
        const contained = yield* git
          .execute({
            cwd,
            operation: "IssueCleanup.verifyDefaultBranch",
            args: ["merge-base", "--is-ancestor", head.stdout.trim(), ref],
            allowNonZeroExit: true,
          })
          .pipe(Effect.mapError(unavailable));
        if (contained.exitCode === 0) {
          merged = true;
          break;
        }
      }
      for (const pr of detail.issue.pullRequests ?? []) {
        if (merged) break;
        const fresh = yield* github
          .getPullRequestDetail({
            cwd,
            host: pr.host,
            repository: pr.repository,
            number: pr.number,
          })
          .pipe(Effect.mapError(unavailable));
        if (
          fresh.state !== "merged" ||
          fresh.baseBranch !== defaultBranch ||
          fresh.headBranch !== branch ||
          !fresh.headSha
        )
          continue;
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
