// @effect-diagnostics nodeBuiltinImport:off -- Provider task files use Node filesystem and path APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";

// Claude's notice ends the path with a sentence period, or the text ends there.
const REPORTED_OUTPUT_PATTERN =
  /Output is being written to: (.+?[\\/]tasks[\\/]([A-Za-z0-9_-]+)\.output)(?=\.?\s|\.?$)/g;

/**
 * The directory of a Claude task output file: null unless `path` is an absolute, normalized
 * `<dir>/tasks/<taskId>.output`.
 */
export function claudeTaskOutputDir(path: string): string | null {
  return NodePath.isAbsolute(path) &&
    NodePath.normalize(path) === path &&
    /[\\/]tasks[\\/][A-Za-z0-9_-]+\.output$/.test(path)
    ? NodePath.dirname(path)
    : null;
}

/** Every task output file Claude reported in a tool result ("Output is being written to: …"). */
export function reportedTaskOutputPaths(
  itemOutput: string,
): ReadonlyArray<{ readonly taskId: string; readonly path: string }> {
  return [...itemOutput.matchAll(REPORTED_OUTPUT_PATTERN)].flatMap(([, path = "", taskId = ""]) =>
    claudeTaskOutputDir(path) === null ? [] : [{ taskId, path }],
  );
}

/** Largest Codex command log kept; past it the log is cut to its newest half. */
const BACKGROUND_TASK_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** The server-owned log a Codex command's streamed output goes to. */
export function codexBackgroundTaskLogPath(
  logsDir: string,
  threadId: string,
  nativeItemId: string,
): string {
  return NodePath.join(
    logsDir,
    "background-tasks",
    `${Base64Url.encode(threadId)}.${Base64Url.encode(nativeItemId)}.output`,
  );
}

async function appendCapped(path: string, text: string, capBytes: number): Promise<void> {
  await NodeFSP.appendFile(path, text);
  if ((await NodeFSP.stat(path)).size <= capBytes) return;
  // Readers see the shrink as a reset: the viewer reloads its tail, `tail -F` reports truncation.
  const contents = await NodeFSP.readFile(path);
  await NodeFSP.writeFile(path, contents.subarray(contents.length - Math.floor(capBytes / 2)));
}

/**
 * Appends Codex command output to per-command logs off the event path: one ordered writer per
 * log, with pending text coalesced and capped in memory. A log is deleted when its command ends
 * (`remove`) and every log this writer made is deleted when its scope (the provider session)
 * closes, so logs live only as long as the commands that fill them.
 */
export const makeBackgroundTaskLogWriter = Effect.fn("orchestration.makeBackgroundTaskLogWriter")(
  function* (logsDir: string, capBytes = BACKGROUND_TASK_LOG_MAX_BYTES) {
    const written = new Set<string>();
    // Registered before the worker, so it runs after the worker fiber is interrupted.
    // ponytail: logs of a server that crashes mid-command stay behind; sweep the directory on
    // startup if that ever piles up.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.all([...written].map((path) => NodeFSP.rm(path, { force: true }))),
      ),
    );
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(logsDir, "background-tasks"), { recursive: true }),
    );
    const worker = yield* makeKeyedCoalescingWorker<
      string,
      { readonly text: string; readonly remove: boolean },
      never,
      never
    >({
      merge: (current, next) =>
        next.remove ? next : { text: (current.text + next.text).slice(-capBytes), remove: false },
      process: (path, entry) =>
        Effect.tryPromise(() =>
          entry.remove
            ? NodeFSP.rm(path, { force: true })
            : appendCapped(path, entry.text, capBytes),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Background task log write failed.", { path, cause }),
          ),
        ),
    });
    const pathOf = (threadId: string, nativeItemId: string) =>
      codexBackgroundTaskLogPath(logsDir, threadId, nativeItemId);
    return {
      append: (threadId: string, nativeItemId: string, text: string) =>
        Effect.suspend(() => {
          const path = pathOf(threadId, nativeItemId);
          written.add(path);
          return worker.enqueue(path, { text, remove: false });
        }),
      remove: (threadId: string, nativeItemId: string) =>
        Effect.suspend(() => {
          const path = pathOf(threadId, nativeItemId);
          if (!written.delete(path)) return Effect.void;
          return worker.enqueue(path, { text: "", remove: true });
        }),
      /** Resolves once everything queued for that log is on disk. */
      drain: (threadId: string, nativeItemId: string) =>
        worker.drainKey(pathOf(threadId, nativeItemId)),
    };
  },
);
