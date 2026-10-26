import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type IssueCleanupInput,
  type IssueDetailResult,
  ThreadId,
} from "@t3tools/contracts";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import type { GitHubPullRequestCore } from "@t3tools/source-control-github/server/gitHubPullRequestJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as StorageCleanup from "../storageCleanup.ts";
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
  yield* git(["checkout", "issue-work"]);
  yield* fs.writeFileString(path.join(cwd, "file"), "issue work");
  yield* git(["commit", "-am", "issue work"]);
  const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  yield* git(["checkout", "main"]);
  const worktreePath = path.join(cwd, ".worktrees/worker");
  yield* fs.makeDirectory(path.join(cwd, ".worktrees"));
  const thread: OrchestrationV2ThreadShell = {
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
  let beforeDelete = Effect.void;
  let prBase = "main";
  let prState: "merged" | "closed" | "open" = "merged";
  const cleanupLayer = IssueCleanup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitVcsDriver.GitVcsDriver, {
          ...driver,
          deleteLocalBranch: (input) =>
            beforeDelete.pipe(Effect.andThen(driver.deleteLocalBranch(input))),
        }),
        Layer.mock(StorageCleanup.StorageCleanup)({
          removeWorktreeNow: () => Effect.succeed({ outcome: "kept", reason: "Open terminal" }),
        }),
        Layer.mock(IssueRoadmap.IssueRoadmap)({ detail: () => Effect.succeed(detail) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(thread),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
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
        }),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
          getPullRequestDetail: () =>
            Effect.succeed({
              state: prState,
              baseBranch: prBase,
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
    thread,
    checkoutBeforeDelete: () => {
      beforeDelete = git(["worktree", "add", worktreePath, "issue-work"]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    },
    prBase: (base: string) => {
      prBase = base;
    },
    cleanup: cleanup.cleanup,
    prState: (state: typeof prState) => {
      prState = state;
    },
  };
});

it.effect(
  "refuses deletion without consent, while checked out in any worktree, or without default-branch integration",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.equal(
        (yield* f.cleanup({ ...f.input, confirmed: false }).pipe(Effect.flip)).code,
        "confirmation-required",
      );
      yield* f.git(["worktree", "add", f.worktreePath, "issue-work"]);
      const checkedOut = yield* f.cleanup(f.input).pipe(Effect.flip);
      assert.equal(checkedOut.code, "checked-out");
      assert.equal(
        checkedOut.message,
        "Checked out in worker; remove the worktree or switch its branch first.",
      );
      assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(f.worktreePath));
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
  "requires unmerged consent for integration PRs but accepts squash merges into the default branch",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(["branch", "unmerged-integration", "issue-work"]);
      f.prBase("unmerged-integration");
      assert.equal((yield* f.cleanup(f.input).pipe(Effect.flip)).code, "unmerged");
      assert.equal((yield* f.git(["show-ref", "--verify", "refs/heads/issue-work"])).exitCode, 0);
      yield* f.git(["merge", "--squash", "issue-work"]);
      yield* f.git(["commit", "-m", "squash"]);
      f.prBase("main");
      yield* f.cleanup(f.input);
      assert.equal((yield* f.git(["branch", "--list", "issue-work"])).stdout, "");
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect(
  "accepts ancestry on the local or freshly fetched remote default branch without a merged PR",
  () =>
    Effect.gen(function* () {
      for (const remote of [false, true]) {
        const f = yield* fixture();
        const path = yield* Path.Path;
        f.prState("open");
        yield* f.git(["branch", "trunk", "issue-work"]);
        if (remote) {
          const remotePath = path.join(f.cwd, "remote.git");
          yield* f.git(["clone", "--bare", f.cwd, remotePath]);
          yield* f.git(["branch", "-f", "trunk", "main"]);
          yield* f.git(["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
          yield* f.git(["remote", "add", "origin", remotePath]);
          // No cached remote HEAD or tracking branch: cleanup must read and fetch them.
        } else {
          yield* f.git(["merge", "--ff-only", "issue-work"]);
        }
        yield* f.cleanup(f.input);
        assert.equal((yield* f.git(["branch", "--list", "issue-work"])).stdout, "");
      }
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("surfaces Git's refusal when a branch is checked out after the initial check", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.checkoutBeforeDelete();
    const error = yield* f.cleanup(f.input).pipe(Effect.flip);
    assert.equal(error.code, "checked-out");
    assert.equal(error.worktreeName, "worker");
    assert.equal((yield* f.git(["show-ref", "--verify", "refs/heads/issue-work"])).exitCode, 0);
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect(
  "requires consent and current closed issue work before requesting leased cleanup, and returns the kept reason",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = { ...f.input, action: "remove-worktree" as const };
      assert.equal(
        (yield* f.cleanup({ ...input, confirmed: false }).pipe(Effect.flip)).code,
        "confirmation-required",
      );
      assert.equal(
        (yield* f.cleanup({ ...input, expectedWorktreePath: "/changed" }).pipe(Effect.flip)).code,
        "work-changed",
      );
      Object.assign(f.detail.issue, { state: "open" });
      assert.equal((yield* f.cleanup(input).pipe(Effect.flip)).code, "not-closed");
      Object.assign(f.detail.issue, { state: "closed" });
      assert.deepEqual(yield* f.cleanup(input), { outcome: "kept", reason: "Open terminal" });
      assert.equal((yield* f.git(["show-ref", "--verify", "refs/heads/issue-work"])).exitCode, 0);
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);
