import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as GitVcsDriver from "./GitVcsDriver.ts";

const errorCode = (error: PlatformError) =>
  error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;

export const makeHiddenTrackedChangeCheck = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Git status and non-forced worktree removal both skip assume-unchanged and skip-worktree files.
  const hiddenTrackedChange = Effect.fn("WorktreeSafety.hiddenTrackedChange")(function* (
    cwd: string,
  ) {
    const inspect = (args: string[], stdin?: string) =>
      git.execute({
        operation: "WorktreeSafety.hiddenTrackedChanges",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: 1024 * 1024,
      });
    const sparse = yield* inspect([
      "config",
      "--type=bool",
      "--default=false",
      "core.sparseCheckout",
    ]);
    // Sparse checkouts flag every file outside the cone; Git 2.37+ unflags those it finds on disk.
    const hiddenTag = sparse.stdout.trim() === "true" ? /^[a-z]$/ : /^(?:S|[a-z])$/;
    const flagged: Array<{ readonly mode: string; readonly id: string; readonly file: string }> =
      [];
    let overflow = false;
    yield* git.execute({
      operation: "WorktreeSafety.hiddenTrackedChanges",
      cwd,
      args: ["-c", "core.quotePath=false", "ls-files", "-s", "-v"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: (line) =>
          Effect.sync(() => {
            const match = /^(\S) (\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(line);
            if (match === null || !hiddenTag.test(match[1]!) || match[2] === "160000") return;
            if (flagged.length < 10_000)
              flagged.push({ mode: match[2]!, id: match[3]!, file: match[4]! });
            else overflow = true;
          }),
      },
    });
    if (overflow) return "hidden tracked files exceed the inspection limit";
    const reason = (file: string) => `has uncommitted changes hidden from git status (${file})`;
    // Quoted names (control characters, quotes, backslashes) and names that are not valid UTF-8
    // decode to text that is not the path on disk.
    const unreadable = flagged.find(({ file }) => file.startsWith('"') || file.includes("\uFFFD"));
    if (unreadable !== undefined) return reason(unreadable.file);
    const onDisk = yield* Effect.forEach(
      flagged,
      (entry) => {
        const file = path.join(cwd, entry.file);
        return fs.readLink(file).pipe(
          Effect.map((target) => ({ ...entry, type: "SymbolicLink", target })),
          Effect.catchIf(
            (error) => errorCode(error) === "EINVAL",
            () => fs.stat(file).pipe(Effect.map((info) => ({ ...entry, type: info.type }))),
          ),
          Effect.catchIf(
            (error) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR",
            () => Effect.succeed(null),
          ),
        );
      },
      { concurrency: 16 },
    );
    const files: Array<{ readonly id: string; readonly file: string }> = [];
    // Without core.symlinks a tracked link is a regular file holding its target, compared unfiltered.
    const linkFiles: typeof files = [];
    for (const entry of onDisk) {
      if (entry === null) continue;
      if (entry.type === "File") (entry.mode === "120000" ? linkFiles : files).push(entry);
      else if (!("target" in entry) || entry.mode !== "120000") return reason(entry.file);
      // Hashing a link's path would hash the file it points to.
      else if (
        (yield* inspect(["hash-object", "--stdin"], entry.target)).stdout.trim() !== entry.id
      )
        return reason(entry.file);
    }
    const hashPaths = (entries: ReadonlyArray<{ readonly file: string }>, flags: string[]) =>
      entries.length === 0
        ? Effect.succeed([])
        : inspect(
            ["hash-object", ...flags, "--stdin-paths"],
            entries.map(({ file }) => `${file}\n`).join(""),
          ).pipe(Effect.map((result) => result.stdout.split("\n")));
    const worktreeIds = yield* hashPaths(files, []);
    const linkIds = yield* hashPaths(linkFiles, ["--no-filters"]);
    const changed =
      files.find(({ id }, i) => worktreeIds[i] !== id) ??
      linkFiles.find(({ id }, i) => linkIds[i] !== id);
    return changed === undefined ? null : reason(changed.file);
  });
  return hiddenTrackedChange;
});
