import {
  GitCommandError,
  PROJECT_WORKTREES_FOLDER,
  T3_PROJECT_FILE_NAME,
  type TerminalSummary,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";

import * as TerminalManager from "../terminal/Manager.ts";
import { excludeProjectWorktrees } from "../projectLocalWorktrees.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeHiddenTrackedChangeCheck } from "../vcs/hiddenTrackedChange.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

const slotName = /^slot-[1-9]\d*$/;
const marker = "refs/worktree/t3-issue-slot";
const isGitCommandError = Schema.is(GitCommandError);
const slotArtifacts = new Set([
  "scenarios",
  "scenarios-github-issue-links",
  "scenarios-mobile",
  "scenarios-second-environment",
  "writer-preview",
]);
// Finished setup markers; `setup-running` still blocks release while setup may be live.
const slotMarkers = new Set(["setup-done", "setup-failed"]);

export function isIssueWorktreeSlot(path: Path.Path, worktree: string): boolean {
  return (
    path.basename(path.dirname(worktree)) === PROJECT_WORKTREES_FOLDER &&
    slotName.test(path.basename(worktree))
  );
}

type SlotError = GitCommandError | PlatformError.PlatformError;
type SlotBase = { readonly ref: string; readonly keep: ReadonlyArray<string> };
type Availability = { readonly path: string; readonly reason: string };
type SlotPool = { readonly cwd: string; readonly dir: string; readonly base: SlotBase };

export class IssueWorktreeSlots extends Context.Service<
  IssueWorktreeSlots,
  {
    readonly claim: <E, R>(input: {
      readonly cwd: string;
      readonly branch: string;
      readonly limit: () => Effect.Effect<number, E, R>;
      readonly occupied: (path: string) => Effect.Effect<boolean, E, R>;
      readonly bind: (path: string, branch: string) => Effect.Effect<unknown, E, R>;
    }) => Effect.Effect<
      { readonly path: string; readonly branch: string } | ReadonlyArray<Availability>,
      SlotError | E,
      R
    >;
    readonly maintain: <E, F, R>(input: {
      readonly cwd: string;
      readonly limit: number;
      readonly occupied: (path: string) => Effect.Effect<boolean, E, R>;
      readonly setup: (path: string) => Effect.Effect<void, F, R>;
      readonly report: (availability: Availability) => void;
    }) => Effect.Effect<void, SlotError, R>;
    readonly release: <E, R>(input: {
      readonly cwd: string;
      readonly path: string;
      readonly branch: string;
      readonly head: string;
      readonly defaultRef: string;
      readonly preserveBranch?: boolean;
      readonly unbind: Effect.Effect<void, E, R>;
    }) => Effect.Effect<string | null, SlotError | E, R>;
    readonly localChanges: (
      cwd: string,
      worktree: string,
      defaultRef: string,
    ) => Effect.Effect<string | null, SlotError>;
  }
>()("t3/issues/IssueWorktreeSlots") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hiddenTrackedChange = yield* makeHiddenTrackedChangeCheck;
  const preparing = new Set<string>();
  const terminalManager = yield* Effect.serviceOption(TerminalManager.TerminalManager);
  const liveTerminals = new Map<string, TerminalSummary>();
  if (Option.isSome(terminalManager)) {
    const unsubscribe = yield* terminalManager.value.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") liveTerminals.clear();
        if (event.type === "remove") {
          liveTerminals.delete(`${event.threadId}/${event.terminalId}`);
          return;
        }
        for (const terminal of event.type === "snapshot" ? event.terminals : [event.terminal]) {
          const key = `${terminal.threadId}/${terminal.terminalId}`;
          if (terminal.status === "running" || terminal.status === "starting")
            liveTerminals.set(key, terminal);
          else liveTerminals.delete(key);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  }
  const hasLiveTerminal = Effect.fn("IssueWorktreeSlots.hasLiveTerminal")(function* (
    target: string,
  ) {
    for (const terminal of liveTerminals.values()) {
      for (const cwd of [terminal.worktreePath, terminal.cwd]) {
        if (cwd === null) continue;
        const real = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
        const relative = path.relative(target, real);
        if (
          relative === "" ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        )
          return true;
      }
    }
    return false;
  });

  const run = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    git.execute({ cwd, args, allowNonZeroExit, operation: "IssueWorktreeSlots.git" });
  const failure = (cwd: string, detail: string) =>
    new GitCommandError({ cwd, detail, operation: "IssueWorktreeSlots", command: "git worktree" });

  const poolDirectory = Effect.fn("IssueWorktreeSlots.poolDirectory")(function* (cwd: string) {
    const [root] = yield* git.listWorktreePaths(cwd);
    if (!root) return yield* failure(cwd, "The repository has no main checkout.");
    const repository = yield* fs.realPath(root);
    const dir = path.join(repository, PROJECT_WORKTREES_FOLDER);
    if ((yield* fs.exists(dir)) && (yield* fs.realPath(dir)) !== dir)
      return yield* failure(dir, "The issue worktree directory is a symbolic link.");
    return { cwd: repository, dir };
  });

  const readBase = Effect.fn("IssueWorktreeSlots.readBase")(function* (cwd: string, ref: string) {
    const sha = (yield* git.resolveCommit({ cwd, revision: ref })).commitSha;
    const file = yield* run(cwd, ["ls-tree", sha, "--", T3_PROJECT_FILE_NAME]);
    if (!file.stdout) return { ref: sha, keep: [] };
    const contents = yield* run(cwd, ["show", `${sha}:${T3_PROJECT_FILE_NAME}`]);
    const config = contents.stdoutTruncated ? null : parseT3ProjectFile(contents.stdout);
    if (config === null) return yield* failure(cwd, "The default branch has an invalid t3.json.");
    return { ref: sha, keep: config.issueWorktreeKeepPaths ?? [] };
  });

  const fetchBase = Effect.fn("IssueWorktreeSlots.fetchBase")(function* (cwd: string) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd);
    if (remote === null) return yield* failure(cwd, "Issue worktree slots require a Git remote.");
    const branch =
      (yield* git.resolveDefaultBranchName(cwd, remote)) ??
      /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(
        (yield* run(cwd, ["ls-remote", "--symref", "--", remote, "HEAD"])).stdout,
      )?.[1];
    if (!branch) return yield* failure(cwd, "The remote default branch is unavailable.");
    yield* git.fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: branch });
    return yield* readBase(cwd, `refs/remotes/${remote}/${branch}`);
  });

  const markedSlot = Effect.fn("IssueWorktreeSlots.markedSlot")(function* (
    cwd: string,
    target: string,
  ) {
    if ((yield* fs.realPath(target)) !== target) return false;
    const registered = yield* git.listWorktreePaths(cwd);
    if (!registered.includes(target)) return false;
    return (yield* run(target, ["show-ref", "--verify", "--quiet", marker], true)).exitCode === 0;
  });

  const exclusions = (keep: ReadonlyArray<string>) =>
    keep.map((name) => `/${name.replaceAll(" ", "\\ ")}`);
  const lstatIfPresent = (target: string) =>
    fs
      .lstat(target)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
  const disposableArtifacts = Effect.fn("IssueWorktreeSlots.disposableArtifacts")(function* (
    target: string,
    base: SlotBase,
  ) {
    const directory = path.join(target, ".t3");
    const stat = yield* lstatIfPresent(directory);
    const artifacts: string[] = [];
    if (stat === null) return artifacts;
    if (stat.type !== "Directory") return ".t3 is not a directory";
    const keep = base.keep.map((entry) => entry.toLowerCase());
    for (const entry of yield* fs.readDirectory(directory)) {
      const type = (yield* lstatIfPresent(path.join(directory, entry)))?.type;
      if (
        !(slotArtifacts.has(entry) && type === "Directory") &&
        !(slotMarkers.has(entry) && type === "File")
      )
        return "has local files in .t3 outside the known artifact directories";
      const name = `.t3/${entry}`;
      // Git can remove a nested repository without checking keep paths inside it.
      if (
        keep.some(
          (entry) => name === entry || name.startsWith(`${entry}/`) || entry.startsWith(`${name}/`),
        )
      )
        return "has a .t3 artifact that overlaps a keep path";
      artifacts.push(name);
    }
    return artifacts;
  });
  const localFiles = (cwd: string, keep: ReadonlyArray<string>, includeIgnored: boolean) =>
    run(cwd, [
      "ls-files",
      "-z",
      "--others",
      ...(includeIgnored ? [] : ["--exclude-standard"]),
      ...exclusions(keep).map((pattern) => `--exclude=${pattern}`),
    ]);
  const localChanges = Effect.fn("IssueWorktreeSlots.localChanges")(function* (
    target: string,
    base: SlotBase,
    includeIgnored = false,
  ) {
    const tracked = yield* run(target, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=none",
    ]);
    if (tracked.stdout || tracked.stdoutTruncated) return "has uncommitted changes";
    const untracked = yield* localFiles(target, base.keep, false);
    if (untracked.stdout || untracked.stdoutTruncated)
      return includeIgnored
        ? "has local files outside the keep paths"
        : "has untracked files outside the keep paths";
    const artifacts = yield* disposableArtifacts(target, base);
    if (typeof artifacts === "string") return artifacts;
    if (includeIgnored) {
      const ignored = yield* localFiles(target, [...base.keep, ...artifacts], true);
      if (ignored.stdout || ignored.stdoutTruncated)
        return "has local files outside the keep paths";
    }
    return yield* hiddenTrackedChange(target);
  });

  const clean = Effect.fn("IssueWorktreeSlots.clean")(function* (
    target: string,
    base: SlotBase,
    preserveIgnored = false,
  ) {
    const artifacts = yield* disposableArtifacts(target, base);
    if (typeof artifacts === "string") return yield* failure(target, artifacts);
    const excludeArgs = exclusions(base.keep).flatMap((pattern) => ["-e", pattern]);
    if (artifacts.length > 0)
      yield* run(target, ["clean", "-qffdx", ...excludeArgs, "--", ...artifacts]);
    if (!preserveIgnored) yield* run(target, ["clean", "-fdx", ...excludeArgs, "-e", "/.t3"]);
    const leftovers = yield* disposableArtifacts(target, base);
    if (typeof leftovers === "string") return yield* failure(target, leftovers);
    if (leftovers.length > 0) return yield* failure(target, "could not clean the .t3 artifacts");
    const remaining = yield* localFiles(target, base.keep, true);
    if (remaining.stdout || remaining.stdoutTruncated) {
      const [firstPath = ""] = remaining.stdout.split("\0", 1);
      return yield* failure(
        target,
        `Git could not clean "${firstPath.slice(0, 180).replace(/[\p{Cc}\p{Cf}]/gu, "?")}". Move it out of the slot or add a keep path in t3.json.`,
      );
    }
  });

  const preparationReason = (cause: unknown, fallback: string) =>
    isGitCommandError(cause) && cause.operation === "IssueWorktreeSlots" ? cause.detail : fallback;

  const currentBranch = Effect.fn("IssueWorktreeSlots.currentBranch")(function* (target: string) {
    const result = yield* run(target, ["symbolic-ref", "--quiet", "HEAD"], true);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) return yield* failure(target, "The slot branch could not be read.");
    return result.stdout.trim();
  });

  const containedInDefault = Effect.fn("IssueWorktreeSlots.containedInDefault")(function* (
    target: string,
    base: SlotBase,
  ) {
    return (
      (yield* run(target, ["merge-base", "--is-ancestor", "HEAD", base.ref], true)).exitCode === 0
    );
  });

  const inspectIdle = Effect.fn("IssueWorktreeSlots.inspectIdle")(function* (
    pool: SlotPool,
    target: string,
    exists: boolean,
  ) {
    if (!exists) return null;
    if (!(yield* markedSlot(pool.cwd, target))) return "is not a registered issue worktree slot";
    const changes = yield* localChanges(target, pool.base);
    if (changes !== null) return changes;
    if (!(yield* containedInDefault(target, pool.base)))
      return "has commits outside the default branch";
    return null;
  });

  const create = Effect.fn("IssueWorktreeSlots.create")(function* (pool: SlotPool, target: string) {
    const commonDir = (yield* run(pool.cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
    yield* excludeProjectWorktrees(pool.cwd, path.resolve(pool.cwd, commonDir), pool.cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* git.createWorktree(
      { cwd: pool.cwd, refName: pool.base.ref, path: target },
      { detached: true },
    );
    yield* run(target, ["update-ref", marker, "HEAD"]);
  });

  const detach = Effect.fn("IssueWorktreeSlots.detach")(function* (target: string, base: SlotBase) {
    yield* run(target, [
      "switch",
      "--detach",
      "--recurse-submodules",
      "--no-overwrite-ignore",
      base.ref,
    ]);
  });
  const reset = Effect.fn("IssueWorktreeSlots.reset")(function* (target: string, base: SlotBase) {
    yield* detach(target, base);
    yield* clean(target, base);
  });

  const claim: IssueWorktreeSlots["Service"]["claim"] = Effect.fn("IssueWorktreeSlots.claim")(
    function* (input) {
      const directory = yield* poolDirectory(input.cwd);
      return yield* withWorkspaceLease(
        directory.dir,
        Effect.gen(function* () {
          const limit = yield* input.limit();
          const unavailable: Availability[] = [];
          let base: SlotBase | undefined;
          for (let index = 1; index <= limit; index++) {
            const target = path.join(directory.dir, `slot-${index}`);
            const result = yield* withWorkspaceLease(
              target,
              Effect.gen(function* () {
                if (preparing.has(target)) return "is being prepared";
                if ((yield* input.occupied(target)) || (yield* hasLiveTerminal(target)))
                  return "is reserved by another thread or terminal";
                base ??= yield* fetchBase(directory.cwd);
                const exists = yield* fs.exists(target);
                const reason = yield* inspectIdle({ ...directory, base }, target, exists);
                if (reason !== null) return reason;
                if (!exists) yield* create({ ...directory, base }, target);
                if (index > (yield* input.limit())) return "is outside the current worker limit";
                const branches = new Set(yield* git.listLocalBranchNames(directory.cwd));
                let branch = input.branch;
                let suffix = 2;
                while (branches.has(branch)) branch = `${input.branch}-${suffix++}`;
                const startRef = base.ref;
                const rollback = Effect.gen(function* () {
                  if (
                    (yield* input.occupied(target)) ||
                    (yield* currentBranch(target)) !== `refs/heads/${branch}` ||
                    (yield* git.resolveCommit({ cwd: target, revision: "HEAD" })).commitSha !==
                      startRef ||
                    (yield* localChanges(target, base!)) !== null
                  )
                    return;
                  yield* run(target, ["switch", "--detach", "--no-overwrite-ignore", startRef]);
                  yield* git.deleteLocalBranch({
                    cwd: directory.cwd,
                    refName: branch,
                    force: true,
                  });
                }).pipe(Effect.ignore({ log: true }));
                const unavailable = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const checkout = yield* run(target, [
                      "switch",
                      "--no-overwrite-ignore",
                      "--recurse-submodules",
                      "-c",
                      branch,
                      startRef,
                    ]).pipe(Effect.andThen(clean(target, base!)), Effect.result);
                    if (Result.isFailure(checkout)) {
                      yield* rollback;
                      yield* Effect.logWarning("Issue worktree slot could not be prepared", {
                        path: target,
                        cause: checkout.failure,
                      });
                      return preparationReason(
                        checkout.failure,
                        "could not be switched or cleaned",
                      );
                    }
                    yield* input.bind(target, branch).pipe(Effect.onError(() => rollback));
                    return null;
                  }),
                );
                if (unavailable !== null) return unavailable;
                return { path: target, branch };
              }),
            );
            if (typeof result !== "string") return result;
            unavailable.push({ path: target, reason: result });
          }
          return unavailable;
        }),
      );
    },
  );

  const maintain: IssueWorktreeSlots["Service"]["maintain"] = Effect.fn(
    "IssueWorktreeSlots.maintain",
  )(function* (input) {
    const directory = yield* poolDirectory(input.cwd);
    yield* Effect.gen(function* () {
      yield* git.pruneWorktrees({ cwd: directory.cwd });
      const existing = (yield* git.listWorktreePaths(directory.cwd)).filter(
        (target) => path.dirname(target) === directory.dir && isIssueWorktreeSlot(path, target),
      );
      const wanted = Array.from({ length: input.limit }, (_, i) =>
        path.join(directory.dir, `slot-${i + 1}`),
      );
      const wantedPaths = new Set(wanted);
      let base: SlotBase | undefined;
      for (const target of new Set([...wanted, ...existing])) {
        let reserved = false;
        yield* Effect.gen(function* () {
          const ready = yield* withWorkspaceLease(
            target,
            Effect.gen(function* () {
              if (
                preparing.has(target) ||
                (yield* input.occupied(target)) ||
                (yield* hasLiveTerminal(target))
              )
                return false;
              base ??= yield* fetchBase(directory.cwd);
              const exists = yield* fs.exists(target);
              const reason = yield* inspectIdle({ ...directory, base }, target, exists);
              if (reason !== null) {
                input.report({ path: target, reason });
                return false;
              }
              if (!wantedPaths.has(target)) {
                if (exists) {
                  yield* clean(target, base);
                  // Git has verified all remaining files are declared disposable slot artifacts.
                  yield* git.removeWorktree({ cwd: directory.cwd, path: target, force: true });
                }
                return false;
              }
              if (exists) yield* reset(target, base);
              else yield* create({ ...directory, base }, target);
              preparing.add(target);
              reserved = true;
              return true;
            }),
          );
          if (ready) yield* input.setup(target);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (reserved) preparing.delete(target);
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Issue worktree slot upkeep failed", { path: target, cause }).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  input.report({
                    path: target,
                    reason: preparationReason(cause, "could not be refreshed"),
                  }),
                ),
              ),
            ),
          ),
        );
      }
    });
  });

  const release: IssueWorktreeSlots["Service"]["release"] = Effect.fn("IssueWorktreeSlots.release")(
    function* (input) {
      if (!(yield* markedSlot(input.cwd, input.path)))
        return "is not a registered issue worktree slot";
      const base = yield* readBase(input.cwd, input.defaultRef);
      const reason = yield* localChanges(input.path, base, input.preserveBranch);
      if (reason !== null) return reason;
      const checkedOut = yield* currentBranch(input.path);
      const branchRef = `refs/heads/${input.branch}`;
      if (checkedOut !== null && checkedOut !== branchRef) return "branch changed since check";
      if (checkedOut === null && !(yield* containedInDefault(input.path, base)))
        return "detached slot has commits outside the default branch";
      const head = yield* git.resolveCommit({ cwd: input.path, revision: branchRef });
      if (head.commitSha !== input.head) return "commit changed since check";
      yield* detach(input.path, base);
      yield* clean(input.path, base, input.preserveBranch);
      yield* input.unbind;
      if (!input.preserveBranch)
        yield* git
          .deleteLocalBranch({ cwd: input.cwd, refName: input.branch, force: true })
          .pipe(Effect.ignore({ log: true }));
      return null;
    },
  );

  return IssueWorktreeSlots.of({
    claim,
    maintain,
    release,
    localChanges: Effect.fn("IssueWorktreeSlots.checkLocalChanges")(function* (cwd, target, ref) {
      return yield* localChanges(target, yield* readBase(cwd, ref));
    }),
  });
});

export const layer = Layer.effect(IssueWorktreeSlots, make);
