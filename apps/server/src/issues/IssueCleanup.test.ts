import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type IssueCleanupInput, type IssueDetailResult } from "@t3tools/contracts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import type { GitHubPullRequestCore } from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as IssueCleanup from "./IssueCleanup.ts";
import * as IssueRoadmap from "./IssueRoadmap.ts";

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.fn("test.issueCleanupFixture")(function* (legacyPr = true) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-cleanup-repo-" });
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const git = (args: readonly string[]) =>
    driver.execute({ cwd, args, operation: "test.issueCleanup" });
  yield* git(["init", "-b", "main"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "file"), "base");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "base"]);
  yield* git(["branch", "issue-work"]);
  const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(cwd, "worker");
  const thread = {
    ...liveThreadShell(ThreadId.make("worker"), { activeRunId: null }),
    status: "completed" as const,
    branch: "issue-work",
    worktreePath,
  };
  const input: IssueCleanupInput = {
    host: "github.com",
    repository: "owner/repo",
    number: 1,
    threadId: thread.id,
    expectedBranch: thread.branch,
    expectedWorktreePath: worktreePath,
    action: "delete-branch",
    confirmed: true,
    confirmUnmerged: false,
  };
  const pr = {
    host: input.host,
    repository: input.repository,
    number: 2,
    url: "https://github.com/owner/repo/pull/2",
    title: "Fix",
    state: "merged" as const,
    isDraft: false,
  };
  const detail: IssueDetailResult = {
    repository: input,
    viewer: null,
    fetchedAt: "2026-10-20T12:00:00Z",
    body: "",
    comments: [],
    linkedPullRequests: [],
    issue: {
      number: 1,
      title: "Fix",
      url: "https://github.com/owner/repo/issues/1",
      state: "closed",
      stateReason: "completed",
      author: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-20T12:00:00Z",
      closedAt: "2026-10-20T12:00:00Z",
      commentCount: 0,
      pullRequests: [pr],
      liveWork: [
        {
          threadId: thread.id,
          title: thread.title,
          branch: thread.branch,
          worktreePath,
          status: "idle",
          pullRequests: legacyPr ? [pr.url] : [],
        },
      ],
    },
  };
  let prState: "merged" | "closed" | "open" = "merged";
  const cleanupLayer = IssueCleanup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitVcsDriver.GitVcsDriver, driver),
        Layer.mock(IssueRoadmap.IssueRoadmap)({ detail: () => Effect.succeed(detail) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(thread),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId: thread.projectId,
                title: "Repo",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: detail.fetchedAt,
                updatedAt: detail.fetchedAt,
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          getPullRequestDetail: () =>
            Effect.succeed({
              state: prState,
              headBranch: thread.branch,
              headSha: base,
            } as GitHubPullRequestCore),
        }),
      ),
    ),
  );
  const cleanup = yield* IssueCleanup.IssueCleanup.pipe(Effect.provide(cleanupLayer));
  return {
    cwd,
    git,
    input,
    worktreePath,
    detail,
    cleanup: cleanup.cleanup,
    prState: (state: typeof prState) => {
      prState = state;
    },
  };
});

it.effect(
  "refuses deletion without consent, while checked out in any worktree, or without a merged PR",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.equal(
        (yield* f.cleanup({ ...f.input, confirmed: false }).pipe(Effect.flip)).code,
        "confirmation-required",
      );
      yield* f.git(["worktree", "add", f.worktreePath, "issue-work"]);
      assert.equal((yield* f.cleanup(f.input).pipe(Effect.flip)).code, "checked-out");
      assert.equal(
        (yield* f.cleanup({ ...f.input, confirmUnmerged: true }).pipe(Effect.flip)).code,
        "checked-out",
      );
      yield* f.git(["worktree", "remove", f.worktreePath]);
      for (const state of ["open", "closed"] as const) {
        f.prState(state);
        assert.equal((yield* f.cleanup(f.input).pipe(Effect.flip)).code, "unmerged");
        assert.equal((yield* f.git(["show-ref", "--verify", "refs/heads/issue-work"])).exitCode, 0);
      }
      yield* f.cleanup({ ...f.input, confirmUnmerged: true });
      assert.equal((yield* f.git(["branch", "--list", "issue-work"])).stdout, "");
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect(
  "deletes merged work but requires extra consent for local commits added after the PR merged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* f.cleanup(f.input);
      assert.equal((yield* f.git(["branch", "--list", "issue-work"])).stdout, "");
      yield* f.git(["checkout", "-b", "issue-work"]);
      yield* f.git(["commit", "--allow-empty", "-m", "unpublished"]);
      yield* f.git(["checkout", "main"]);
      assert.equal((yield* f.cleanup(f.input).pipe(Effect.flip)).code, "unmerged");
      yield* f.cleanup({ ...f.input, confirmUnmerged: true });
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect(
  "removes only a confirmed clean linked worktree and refuses stale targets and dirty worktrees",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const input = { ...f.input, action: "remove-worktree" as const };
      yield* f.git(["worktree", "add", f.worktreePath, "issue-work"]);
      assert.equal(
        (yield* f
          .cleanup({ ...input, expectedWorktreePath: "/another/worktree" })
          .pipe(Effect.flip)).code,
        "work-changed",
      );
      yield* f.git(["config", "status.showUntrackedFiles", "no"]);
      const file = path.join(f.worktreePath, "untracked");
      yield* fs.writeFileString(file, "keep me");
      assert.equal((yield* f.cleanup(input).pipe(Effect.flip)).code, "dirty-worktree");
      assert.equal(yield* fs.readFileString(file), "keep me");
      yield* fs.remove(file);
      yield* f.cleanup(input);
      assert.isFalse(yield* fs.exists(f.worktreePath));
      yield* f.cleanup(f.input);
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);
