import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { agent, ask, every, issues, runs, skip, start, step, stop, Tick, workflow } = T3;

const repository = "tannerpolley/t3code-sandbox";
const prefix = "https://github.com/" + repository + "/issues/";
const project = process.env.T3_WORKFLOW_PROOF_PROJECT;
if (!project) throw new Error("Set T3_WORKFLOW_PROOF_PROJECT to the private fixture clone.");

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const run = async (cwd: string, command: string, args: string[]) =>
  (await execFile(command, args, { cwd, encoding: "utf8", timeout: 20_000 })).stdout.trim();
const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);
const gh = (...args: string[]) => run(project, "gh", args);
const holds = new Set(["needs you", "needs orchestrator"]);
const fixtureTitle = "[#691 proof] ";
const model = (name: string) => ({ instanceId: "codex", model: name });

const privateFixture = () =>
  Effect.tryPromise(async () => {
    const repo = JSON.parse(
      await gh("repo", "view", repository, "--json", "isPrivate,defaultBranchRef"),
    );
    if (
      !repo.isPrivate ||
      (await git(project, "remote", "get-url", "--push", "--all", "origin")) !==
        `https://github.com/${repository}.git`
    ) {
      throw new Error("Expected origin to point to the private fixture repository");
    }
    return repo.defaultBranchRef.name;
  });

const handoff = Effect.fn(function* (name: string, title: string, reason: string) {
  yield* ask(name, { title, choices: ["Hold"], data: { reason } });
  return yield* stop(reason);
});

const worker = workflow(
  "issue-pipeline-proof",
  { version: 4, payload: Schema.String, concurrency: 1 },
  Effect.fn(function* (url) {
    const key = url.slice(prefix.length);
    if (!url.startsWith(prefix) || !/^\d+$/.test(key)) return yield* stop("Outside fixture scope");
    const issue = { project, url };
    const detail = yield* step("admission", { returns: T3.IssueDetail }, issues.read(issue));
    if (
      !detail.title.startsWith(fixtureTitle) ||
      detail.state.name !== "Todo" ||
      detail.labels.some(({ name }) => holds.has(name.toLowerCase()))
    ) {
      return yield* skip("Fixture is no longer eligible");
    }

    const target = yield* step(
      "in-progress",
      { returns: Schema.String },
      Effect.gen(function* () {
        const branch = yield* privateFixture();
        yield* issues.setState(issue, "In progress");
        return branch;
      }),
    );
    if (detail.title === fixtureTitle + "Hold a queued workflow") {
      yield* ask("hold-fixture", { title: "Stop this queued proof fixture?", choices: ["Hold"] });
      return yield* stop("Held fixture");
    }

    const branch = "t3-workflow-proof-691-" + key;
    const file = "docs/workflow-proof-691-" + key + ".txt";
    const expected = "workflow proof";

    const implement = yield* agent("implement", {
      project,
      issue,
      model: model("gpt-6.2-sol"),
      workspace: { type: "worktree", baseRef: target, startFromOrigin: true, branch },
      runtimeMode: "full-access",
      timeout: "4 minutes",
      brief: `This is a private test fixture. In this worktree, create ${file} with exactly one line: draft. Commit just that file on the provided branch. This intentional draft exercises the review fix loop. Do not push, open a PR or change GitHub. Reply once committed.`,
    });

    const worktree = yield* step(
      "find-worktree",
      { returns: Schema.String },
      Effect.tryPromise(async () => {
        const entry = (await git(project, "worktree", "list", "--porcelain", "-z"))
          .split("\0\0")
          .find((row) => row.split("\0").includes("branch refs/heads/" + branch));
        if (!entry?.startsWith("worktree ")) throw new Error("Implementation worktree missing");
        return entry.split("\0")[0].slice("worktree ".length);
      }),
    );

    const review = Effect.fn(function* (name: string) {
      const snapshot = yield* step(
        name + "-snapshot",
        { returns: Schema.Struct({ head: Schema.String, diff: Schema.String }) },
        Effect.tryPromise(async () => {
          const head = await git(worktree, "rev-parse", "HEAD");
          const diff = await git(
            worktree,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "origin/" + target + "..." + head,
          );
          return { head, diff };
        }),
      );
      const verdict = yield* agent(name, {
        project,
        issue,
        model: model("gpt-6.2-astra"),
        workspace: { type: "existing_worktree", worktreePath: worktree, branch },
        runtimeMode: "approval-required",
        timeout: "4 minutes",
        returns: Schema.Struct({ approved: Schema.Boolean, finding: Schema.String }),
        brief: `Review the supplied committed diff at ${snapshot.head}. The only expected change is adding ${file} with exactly one line: ${expected}. Report whether the diff matches and quote any mismatch. Use the supplied patch as your only input. Do not run shell commands or invoke tools except to submit your verdict.

${snapshot.diff}`,
      });
      return { ...verdict, head: snapshot.head };
    });

    let verdict = yield* review("review");
    if (!verdict.value.approved) {
      yield* agent("fix", {
        thread: implement.thread,
        timeout: "4 minutes",
        brief: `Correct the fixture to exactly one line: ${expected}. Reviewer observed: ${verdict.value.finding}. Commit the fix on the same branch. Do not push or touch GitHub.`,
      });
      verdict = yield* review("review-fix");
    }
    if (!verdict.value.approved) {
      yield* ask("review-blocked", {
        title: "Fixture review still has a blocker",
        choices: ["Hold"],
        data: verdict.value,
      });
      return yield* stop("Review did not pass");
    }

    const checked = yield* step.try(
      "checks",
      { returns: Schema.String },
      Effect.tryPromise(async () => {
        if (
          (await git(worktree, "rev-parse", "HEAD")) !== verdict.head ||
          (await git(worktree, "status", "--porcelain")) !== "" ||
          (await git(worktree, "diff", "--name-only", "origin/" + target + "...HEAD")) !== file ||
          (await NodeFSP.readFile(NodePath.join(worktree, file), "utf8")) !== expected + "\n"
        ) {
          throw new Error("Unexpected fixture diff or uncommitted changes");
        }
        await git(worktree, "diff", "--check", "origin/" + target + "...HEAD");
        await run(worktree, "python3", ["-B", "-m", "unittest"]);
        return verdict.head;
      }),
    );

    if (checked.outcome === "failed") {
      return yield* handoff("checks-blocked", "Fixture checks failed", checked.reason);
    }
    const head = checked.value;

    const opened = yield* step.try(
      "open-pr",
      { returns: Schema.String },
      privateFixture().pipe(
        Effect.andThen(
          Effect.tryPromise(async () => {
            const existing = JSON.parse(
              await gh(
                "pr",
                "list",
                "-R",
                repository,
                "--state",
                "all",
                "--base",
                target,
                "--head",
                branch,
                "--json",
                "url,isCrossRepository",
              ),
            );
            const sameRepository = existing.find((pr) => !pr.isCrossRepository);
            if (sameRepository) return sameRepository.url;
            await git(project, "push", "origin", head + ":refs/heads/" + branch);
            return gh(
              "pr",
              "create",
              "-R",
              repository,
              "--base",
              target,
              "--head",
              branch,
              "--title",
              "test: prove upstream Workflows on issue #" + key,
              "--body",
              "Private fixture for the upstream workflow proof.",
            );
          }),
        ),
      ),
    );
    if (opened.outcome === "failed") {
      return yield* handoff("pr-blocked", "Fixture PR could not be opened", opened.reason);
    }
    const pr = opened.value;

    const answer = yield* ask("merge", {
      title: "Merge the private fixture PR?",
      choices: ["Merge", "Hold"],
      data: { pr, head },
    });
    if (Option.isNone(answer) || answer.value.choice !== "Merge") return yield* stop("Merge held");

    const merged = yield* step.try(
      "merge-reviewed-head",
      { returns: Schema.Void },
      privateFixture().pipe(
        Effect.andThen(
          Effect.tryPromise(async () => {
            const read = async () =>
              JSON.parse(await gh("pr", "view", pr, "--json", "state,headRefOid"));
            let current = await read();
            if (current.headRefOid !== head)
              throw new Error("Fixture PR head changed after checks");
            if (current.state === "OPEN") {
              await gh("pr", "merge", pr, "--squash", "--match-head-commit", head);
              current = await read();
            }
            if (current.state !== "MERGED" || current.headRefOid !== head) {
              throw new Error("Fixture PR merge was not verified");
            }
          }),
        ),
      ),
    );
    if (merged.outcome === "failed") {
      return yield* handoff("merge-blocked", "Fixture PR could not be merged", merged.reason);
    }
    yield* step(
      "done",
      { returns: Schema.Void },
      privateFixture().pipe(Effect.andThen(issues.setState(issue, "Done"))),
    );
    return { pr, head };
  }),
);

workflow(
  "issue-pipeline-proof-poll",
  { version: 4, payload: Tick, triggers: [every("1 minute")], concurrency: 1 },
  Effect.fn(function* () {
    return yield* step(
      "find-and-start",
      { returns: Schema.Array(Schema.String) },
      Effect.gen(function* () {
        const selected: string[] = [];
        const list = yield* issues.list({ project, state: "open", limit: 50 });
        for (const row of list
          .filter((row) => row.url.startsWith(prefix) && row.title.startsWith(fixtureTitle))
          .reverse()) {
          const detail = yield* issues.read(row);
          if (
            detail.state.name !== "Todo" ||
            detail.labels.some(({ name }) => holds.has(name.toLowerCase()))
          )
            continue;
          const [previous] = yield* runs({ workflow: worker, subject: row });
          if (previous && previous.status !== "skipped") continue;
          const key = previous ? row.url + "/" + previous.id : row.url;
          const { runId } = yield* start(worker, row.url, { key, subject: row });
          selected.push(runId);
        }
        return selected;
      }),
    );
  }),
);
