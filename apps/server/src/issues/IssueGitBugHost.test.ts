// @effect-diagnostics nodeBuiltinImport:off - a synchronous probe decides whether git-bug tests run.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as GitBug from "./IssueGitBugHost.ts";
import { issueEligibility } from "./IssueEligibility.ts";

// git-bug is an optional, user-installed binary (v0.11.0 tested); CI does not install it.
const gitBugInstalled = NodeChildProcess.spawnSync("git-bug", ["version"]).status === 0;

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* (yield* ProcessRunner.ProcessRunner).run({ command, args, cwd });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  });

/** A repository with a git-bug identity and a linked worktree, as T3 would see one. */
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const main = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-bug-" });
  const worktree = path.join(main, ".worktrees", "w1");
  yield* run(main, "git", ["init", "-q"]);
  yield* run(main, "git", [
    "-c",
    "user.name=T3",
    "-c",
    "user.email=t3@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  yield* run(main, "git", ["worktree", "add", "-q", worktree]);
  yield* run(main, "git-bug", [
    "user",
    "new",
    "--non-interactive",
    "-n",
    "T3",
    "-e",
    "t3@example.com",
  ]);
  return { main, worktree };
});

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live.skipIf(!gitBugInstalled)(
  "creates, reads, edits, comments on, closes and reopens issues through a linked worktree",
  () =>
    Effect.gen(function* () {
      const { main, worktree } = yield* fixture;
      const repository = "acme/app";
      const viaWorktree = yield* GitBug.make(Effect.succeed([{ repository, cwd: worktree }]));
      const viaMain = yield* GitBug.make(Effect.succeed([{ repository, cwd: main }]));
      const scope = { cwd: main, host: GitBug.GIT_BUG_HOST, repository };

      const created = yield* viaWorktree.createIssue({
        host: GitBug.GIT_BUG_HOST,
        repository,
        title: "Parser fails",
        body: "On an empty file.",
        milestoneNumber: null,
        writeKey: "key-1",
        recover: false,
      });
      const ref = { host: GitBug.GIT_BUG_HOST, repository, number: created.issue.number };
      // A retried create finds the first one by its write marker instead of creating another.
      const recovered = yield* viaMain.createIssue({
        ...ref,
        title: "Parser fails",
        body: "On an empty file.",
        milestoneNumber: null,
        writeKey: "key-1",
      });
      expect(recovered.issue).toEqual(created.issue);
      expect(created.issue.title).toBe("Parser fails");

      yield* viaMain.postComment(ref, "Reproduced.");
      yield* viaMain.updateBody({ ...ref, body: "On an empty or missing file." });
      yield* viaMain.setLabels(ref, ["bug", "parser"], []);
      yield* viaMain.setLabels(ref, ["bug"], ["parser"]);
      yield* viaWorktree.setState({ ...ref, state: "closed" });

      const detail = yield* viaWorktree.detail(ref, {
        accountId: "git-bug",
        viewer: "git-bug",
        credentialFingerprint: "",
      });
      expect(detail.body).toBe("On an empty or missing file.");
      expect(detail.issue).toMatchObject({ state: "closed", labels: [{ name: "bug" }] });
      expect(detail.comments.map((comment) => comment.body)).toEqual(["Reproduced."]);
      expect(detail.issue.relationshipsComplete).toBe(true);
      expect(issueEligibility(yield* viaMain.workRead(ref))).toBe("closed");

      const closed = yield* viaMain.listIssuePage(scope, "open", 1);
      expect("items" in closed && closed.items).toEqual([]);
      yield* viaMain.setState({ ...ref, state: "open" });
      const open = yield* viaWorktree.listIssuePage(scope, "open", 1);
      expect("items" in open && open.items.map((issue) => issue.number)).toEqual([ref.number]);
      // Hosts without blockers or sub-issues must still let managed work start.
      expect(issueEligibility(yield* viaWorktree.workRead(ref))).toBe("eligible");
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.skipIf(!gitBugInstalled)(
  "queues parallel writes from a checkout and its linked worktree behind git-bug's repository lock",
  () =>
    Effect.gen(function* () {
      const { main, worktree } = yield* fixture;
      // Two names on one repository: the queue belongs to the shared .git, not to a checkout.
      const host = yield* GitBug.make(
        Effect.succeed([
          { repository: "acme/main", cwd: main },
          { repository: "acme/worktree", cwd: worktree },
        ]),
      );
      const posted = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? "acme/main" : "acme/worktree")),
        (repository, index) =>
          host.postIssue(
            { host: GitBug.GIT_BUG_HOST, repository },
            { title: `Parallel ${index}`, body: "", labels: ["agent"] },
          ),
        { concurrency: "unbounded" },
      );
      const listed = yield* host.listIssuePage(
        { cwd: main, host: GitBug.GIT_BUG_HOST, repository: "acme/main" },
        "all",
        1,
      );
      expect("items" in listed && listed.items.length).toBe(8);
      expect(new Set(posted.map((issue) => issue.number)).size).toBe(8);
    }).pipe(Effect.scoped, Effect.provide(services)),
);
