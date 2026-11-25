import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as IssueWorktreeSlots from "./IssueWorktreeSlots.ts";

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-slots-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = IssueWorktreeSlots.layer.pipe(Layer.provideMerge(driverLayer));

it.live("reuses a prepared slot from the fetched default and preserves unsafe slots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const slots = yield* IssueWorktreeSlots.IssueWorktreeSlots;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-slots-repo-" });
    const local = path.join(temp, "local");
    const remote = path.join(temp, "remote");
    const run = (cwd: string, ...args: string[]) =>
      git.execute({ cwd, args, operation: "test.issueWorktreeSlots" });
    yield* run(temp, "init", "-b", "main", remote);
    yield* run(remote, "config", "user.name", "Test");
    yield* run(remote, "config", "user.email", "test@example.com");
    yield* fs.writeFileString(
      path.join(remote, "t3.json"),
      '{"issueWorktreeKeepPaths":[".venv",".T3/scenarios-mobile/file"]}',
    );
    yield* fs.writeFileString(path.join(remote, ".gitignore"), "generated/\n/.t3/\n");
    yield* fs.writeFileString(path.join(remote, "tracked"), "base");
    yield* run(remote, "add", ".");
    yield* run(remote, "commit", "-m", "base");
    yield* run(temp, "clone", remote, local);
    const slot = path.join(local, ".worktrees", "slot-1");
    const surplus = path.join(local, ".worktrees", "slot-2");
    const claims = new Set<string>();
    let limit = 2;
    const occupied = (target: string) => Effect.sync(() => claims.has(target));
    const bind = (target: string) =>
      Effect.sync(() => {
        claims.add(target);
      });
    const prepared: string[] = [];
    const reports: string[] = [];
    const maintain = () =>
      slots.maintain({
        cwd: local,
        limit,
        occupied,
        setup: (target) =>
          Effect.sync(() => {
            prepared.push(target);
          }),
        report: ({ reason }) => reports.push(reason),
      });
    const claim = (branch: string) =>
      slots.claim({
        cwd: local,
        branch,
        occupied,
        bind,
        limit: () => Effect.succeed(limit),
      });
    yield* maintain();
    assert.deepEqual(prepared, [slot, surplus]);
    const failedBind = yield* slots
      .claim({
        cwd: local,
        branch: "failed-bind",
        occupied,
        bind: () => Effect.fail("bind failed"),
        limit: () => Effect.succeed(limit),
      })
      .pipe(Effect.flip);
    assert.equal(failedBind, "bind failed");
    assert.equal((yield* run(slot, "branch", "--show-current")).stdout.trim(), "");
    yield* run(slot, "switch", "-c", "abandoned-claim");
    yield* maintain();
    assert.equal((yield* run(slot, "branch", "--show-current")).stdout.trim(), "");
    assert.include(yield* git.listLocalBranchNames(local), "abandoned-claim");
    const [first, second] = yield* Effect.all([claim("issue-1"), claim("issue-2")], {
      concurrency: 2,
    });
    assert.isTrue("branch" in first && "branch" in second);
    if (!("branch" in first) || !("branch" in second)) return;
    assert.sameMembers([first.path, second.path], [slot, surplus]);
    const slotBranch = first.path === slot ? first.branch : second.branch;
    const surplusBranch = first.path === surplus ? first.branch : second.branch;
    assert.deepEqual(yield* claim("issue-3"), [
      { path: slot, reason: "is reserved by another thread or terminal" },
      { path: surplus, reason: "is reserved by another thread or terminal" },
    ]);
    limit = 1;
    yield* maintain();
    assert.isTrue(yield* fs.exists(surplus));
    const head = (yield* git.resolveCommit({ cwd: slot, revision: "HEAD" })).commitSha;
    yield* fs.makeDirectory(path.join(slot, ".venv"));
    yield* fs.writeFileString(path.join(slot, ".venv", "cache"), "keep this");
    yield* fs.makeDirectory(path.join(slot, "generated"));
    yield* fs.writeFileString(path.join(slot, "generated", "stale"), "remove this");
    const generatedScenarioRepo = path.join(slot, ".t3", "scenarios", "fixture");
    yield* run(slot, "init", generatedScenarioRepo);
    yield* fs.writeFileString(path.join(slot, "tracked"), "unsaved");
    const release = (target: string, branch: string) =>
      slots.release({
        cwd: local,
        path: target,
        branch,
        head,
        defaultRef: "origin/main",
        unbind: Effect.void,
      });
    assert.equal(yield* release(slot, slotBranch), "has uncommitted changes");
    assert.equal(yield* fs.readFileString(path.join(slot, "tracked")), "unsaved");
    yield* run(slot, "update-index", "--assume-unchanged", "tracked");
    assert.include(yield* release(slot, slotBranch), "hidden from git status");
    assert.equal(yield* fs.readFileString(path.join(slot, "tracked")), "unsaved");
    yield* run(slot, "update-index", "--no-assume-unchanged", "tracked");
    yield* run(slot, "restore", "tracked");
    const unknownArtifact = path.join(slot, ".t3", "setup-done");
    yield* fs.writeFileString(unknownArtifact, "do not delete");
    assert.equal(
      yield* release(slot, slotBranch),
      "has local files in .t3 outside the known artifact directories",
    );
    assert.equal(yield* fs.readFileString(unknownArtifact), "do not delete");
    yield* fs.remove(unknownArtifact);
    const keptArtifact = path.join(slot, ".t3", "scenarios-mobile");
    yield* run(slot, "init", keptArtifact);
    assert.equal(yield* release(slot, slotBranch), "has a .t3 artifact that overlaps a keep path");
    assert.isTrue(yield* fs.exists(path.join(keptArtifact, ".git")));
    yield* fs.rename(keptArtifact, path.join(slot, ".venv", "kept-artifact"));
    assert.isNull(yield* release(slot, slotBranch));
    yield* run(surplus, "switch", "--detach", "origin/main");
    assert.isNull(yield* release(surplus, surplusBranch));
    claims.clear();
    assert.notInclude(yield* git.listLocalBranchNames(local), slotBranch);
    assert.isFalse(yield* fs.exists(path.join(slot, "generated", "stale")));
    assert.equal(yield* fs.readFileString(path.join(slot, ".venv", "cache")), "keep this");
    assert.isFalse(yield* fs.exists(generatedScenarioRepo));
    yield* fs.writeFileString(path.join(slot, "untracked"), "do not delete");
    assert.deepEqual(yield* claim("issue-3"), [
      { path: slot, reason: "has untracked files outside the keep paths" },
    ]);
    yield* maintain();
    assert.deepEqual(reports, ["has untracked files outside the keep paths"]);
    assert.isFalse(yield* fs.exists(surplus));
    assert.equal(yield* fs.readFileString(path.join(slot, "untracked")), "do not delete");
    yield* fs.rename(path.join(slot, "untracked"), path.join(slot, ".venv", "retained"));
    yield* run(
      slot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "detached work",
    );
    const detachedHead = (yield* git.resolveCommit({ cwd: slot, revision: "HEAD" })).commitSha;
    assert.deepEqual(yield* claim("issue-3"), [
      { path: slot, reason: "has commits outside the default branch" },
    ]);
    assert.equal(
      (yield* git.resolveCommit({ cwd: slot, revision: "HEAD" })).commitSha,
      detachedHead,
    );
    yield* run(slot, "switch", "--detach", "origin/main");
    for (const [relative, reason] of [
      [
        "generated",
        'Git could not clean "generated/". Move it out of the slot or add a keep path in t3.json.',
      ],
      [".t3/scenarios-private", "has local files in .t3 outside the known artifact directories"],
    ] as const) {
      const nested = path.join(slot, relative);
      yield* run(slot, "init", nested);
      assert.deepEqual(yield* claim("issue-3"), [{ path: slot, reason }]);
      yield* maintain();
      assert.equal(reports.at(-1), reason);
      assert.isTrue(yield* fs.exists(path.join(nested, ".git")));
      yield* fs.rename(nested, path.join(slot, ".venv", path.basename(nested)));
    }
    yield* fs.makeDirectory(path.join(slot, "generated"));
    yield* fs.writeFileString(path.join(slot, "generated", "stale"), "recreated during upkeep");
    yield* fs.writeFileString(path.join(remote, "tracked"), "current default");
    yield* run(remote, "commit", "-am", "advance default");
    const current = (yield* git.resolveCommit({ cwd: remote, revision: "HEAD" })).commitSha;
    assert.deepEqual(yield* claim("issue-3"), { path: slot, branch: "issue-3" });
    assert.equal((yield* git.resolveCommit({ cwd: slot, revision: "HEAD" })).commitSha, current);
    assert.equal(yield* fs.readFileString(path.join(slot, ".venv", "retained")), "do not delete");
    assert.isFalse(yield* fs.exists(path.join(slot, "generated", "stale")));
    const writerPreview = path.join(slot, ".t3", "writer-preview");
    yield* run(slot, "init", writerPreview);
    assert.isNull(
      yield* slots.release({
        cwd: local,
        path: slot,
        branch: "issue-3",
        head: current,
        defaultRef: "origin/main",
        preserveBranch: true,
        unbind: Effect.void,
      }),
    );
    assert.isFalse(yield* fs.exists(writerPreview));
    assert.include(yield* git.listLocalBranchNames(local), "issue-3");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
