// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live, read-only output of a thread's background shell or Claude monitor, for the popover viewer
 * and for a terminal tab that follows it.
 *
 * Claude runs `run_in_background` Bash commands with output redirected to a file and reports the
 * path in the tool result ("Output is being written to: <path>"), which a subagent thread's
 * command_execution turn item stores as text. The SDK's background task messages carry ids only
 * until `task_notification.output_file` at the end.
 *
 * A Claude Monitor is a background shell too (`task_type` "local_bash") whose events are the
 * lines it prints to that same `<session tasks dir>/<taskId>.output`. The SDK never streams those
 * events (each one only wakes the agent with a `task-notification` result that names no task)
 * and the Monitor tool result names no file. A top-level Claude shell's item also keeps the
 * structured tool result, which has no path. So the live Claude session remembers the tasks
 * directory Claude last reported (a Bash notice, or any task's final `output_file`).
 *
 * Codex streams command output as `item/commandExecution/outputDelta` notifications; the Codex
 * adapter appends them to a server-owned log per command (`makeBackgroundTaskLogWriter`).
 *
 * In every case the server re-finds the file from the thread's own items or running tasks, so a
 * client can only name a task, never a path.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import {
  type OrchestrationV2BackgroundTaskOutputChunk,
  OrchestrationV2BackgroundTaskOutputError,
  type TerminalFollowBackgroundTaskInput,
  ThreadId,
} from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { findBackgroundTaskSession } from "../orchestration-v2/BackgroundTaskStop.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { watchedLogPaths } from "./watchedLogPaths.ts";

/** Largest tail sent at once; the client keeps a buffer of the same size. */
export const BACKGROUND_TASK_OUTPUT_TAIL_BYTES = 200 * 1024;

// Claude task ids are short alphanumerics; anything else cannot name a reported task file.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

/** The output file Claude reported for `taskId` in a background Bash tool result, or null. */
export function backgroundTaskOutputPath(itemOutput: string, taskId: string): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  return reportedTaskOutputPaths(itemOutput).find((entry) => entry.taskId === taskId)?.path ?? null;
}

export interface OutputTailState {
  offset: number | null;
  decoder: NodeStringDecoder.StringDecoder;
}

export const initialOutputTailState = (): OutputTailState => ({
  offset: null,
  decoder: new NodeStringDecoder.StringDecoder("utf8"),
});

/**
 * Reads what the file gained since the last call. The first read, a shrunk file, or growth past
 * `capBytes` resets to the last `capBytes`; no growth returns null.
 */
export async function readOutputTail(
  path: string,
  state: OutputTailState,
  capBytes = BACKGROUND_TASK_OUTPUT_TAIL_BYTES,
): Promise<OrchestrationV2BackgroundTaskOutputChunk | null> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const { size } = await handle.stat();
    const reset = state.offset === null || size < state.offset || size - state.offset > capBytes;
    if (!reset && size === state.offset) return null;
    const start = reset ? Math.max(0, size - capBytes) : (state.offset ?? 0);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (reset) state.decoder = new NodeStringDecoder.StringDecoder("utf8");
    state.offset = start + bytesRead;
    return { text: state.decoder.write(buffer.subarray(0, bytesRead)), reset };
  } finally {
    await handle.close();
  }
}

/** Largest Codex command log kept; past it the log is cut to its newest half. */
export const BACKGROUND_TASK_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** The server-owned log a Codex command's streamed output goes to. */
export function codexBackgroundTaskLogPath(
  logsDir: string,
  threadId: string,
  nativeItemId: string,
): string {
  return NodePath.join(
    logsDir,
    "background-tasks",
    `${Encoding.encodeBase64Url(threadId)}.${Encoding.encodeBase64Url(nativeItemId)}.output`,
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

const outputError = (taskId: string, message: string, cause?: unknown) =>
  new OrchestrationV2BackgroundTaskOutputError({
    taskId,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** The parts of a command_execution turn item that name its output. */
const decodeCommandItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      driver: Schema.optional(Schema.String),
      output: Schema.optional(Schema.NullOr(Schema.String)),
      nativeItemRef: Schema.optional(Schema.NullOr(Schema.Struct({ nativeId: Schema.String }))),
    }),
  ),
);

/**
 * The output file of one of `threadId`'s background shells or Claude monitors. `appearsLater`
 * marks a Codex log, which exists only once the command has printed something.
 */
export const resolveBackgroundTaskOutputFile = Effect.fn(
  "orchestration.resolveBackgroundTaskOutputFile",
)(function* (input: { readonly threadId: string; readonly taskId: string }) {
  const sql = yield* SqlClient.SqlClient;
  const { logsDir } = yield* ServerConfig;
  const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId}
        AND type = 'command_execution'
        AND (
          payload_json LIKE ${`%${input.taskId}.output%`}
          OR json_extract(payload_json, '$.nativeItemRef.nativeId') = ${input.taskId}
        )
    `.pipe(
    Effect.mapError((cause) =>
      outputError(input.taskId, "Failed to look up the background task.", cause),
    ),
  );
  for (const row of rows) {
    const item = Option.getOrNull(decodeCommandItem(row.payload_json));
    if (item === null) continue;
    if (item.driver === "codex" && item.nativeItemRef?.nativeId === input.taskId) {
      return {
        path: codexBackgroundTaskLogPath(logsDir, input.threadId, input.taskId),
        appearsLater: true,
      };
    }
    const path = item.output ? backgroundTaskOutputPath(item.output, input.taskId) : null;
    if (path !== null) return { path, appearsLater: false };
  }
  // A Claude monitor's tool result names no file, and a top-level Claude shell's item keeps the
  // structured result without the path, so ask the live session where its task files go.
  const found = yield* findBackgroundTaskSession({
    threadId: ThreadId.make(input.threadId),
    taskId: input.taskId,
  }).pipe(
    Effect.mapError((cause) =>
      outputError(input.taskId, "Failed to look up the background task.", cause),
    ),
  );
  if (found === null || !TASK_ID_PATTERN.test(input.taskId)) {
    return yield* outputError(
      input.taskId,
      "This thread has no running background task with that id.",
    );
  }
  if (found.runtime === null) {
    return yield* outputError(input.taskId, "The provider session running this task has ended.");
  }
  if (found.runtime.backgroundTaskOutputDir === undefined) {
    return yield* outputError(
      input.taskId,
      `Provider '${found.runtime.driver}' does not report where this task's output goes.`,
    );
  }
  const dir = yield* found.runtime.backgroundTaskOutputDir({
    providerThread: found.providerThread,
  });
  if (dir === null) {
    return yield* outputError(
      input.taskId,
      "Claude has not reported where this session keeps task output yet. It does once any of its background shells starts or ends.",
    );
  }
  return { path: NodePath.join(dir, `${input.taskId}.output`), appearsLater: false };
});

const isMissingFile = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export const subscribeBackgroundTaskOutput = Effect.fn(
  "orchestration.subscribeBackgroundTaskOutput",
)(function* (input: { readonly threadId: string; readonly taskId: string }) {
  const { path, appearsLater } = yield* resolveBackgroundTaskOutputFile(input);
  const state = initialOutputTailState();
  // ponytail: 1s stat polling per open viewer; switch to fs.watch if viewers get numerous.
  return Stream.fromEffectSchedule(
    Effect.tryPromise({
      try: () =>
        readOutputTail(path, state).catch((cause: unknown) => {
          if (appearsLater && isMissingFile(cause)) return null;
          throw cause;
        }),
      catch: (cause) =>
        outputError(input.taskId, "Background task output is no longer readable.", cause),
    }),
    Schedule.spaced("1 second"),
  ).pipe(Stream.filter((chunk) => chunk !== null));
});

/** The turn items that can start a background task, with the command they ran. */
const decodeTaskItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("command_execution"),
        input: Schema.String,
        output: Schema.optional(Schema.NullOr(Schema.String)),
        nativeItemRef: Schema.optional(Schema.NullOr(Schema.Struct({ nativeId: Schema.String }))),
      }),
      // A Claude Monitor.
      Schema.Struct({
        type: Schema.Literal("dynamic_tool"),
        input: Schema.Struct({ command: Schema.String }),
        output: Schema.Struct({ taskId: Schema.String }),
      }),
    ]),
  ),
);

/**
 * The command text that started one of `threadId`'s background tasks, or null: a Claude
 * monitor's `command`, or the shell command of a Claude background Bash call (a subagent's
 * result notice names the task's file, a top-level one's structured result its
 * `backgroundTaskId`) or of a Codex command (its item id is the task id).
 */
export const findBackgroundTaskCommand = Effect.fn("orchestration.findBackgroundTaskCommand")(
  function* (input: { readonly threadId: string; readonly taskId: string }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId}
        AND type IN ('command_execution', 'dynamic_tool')
        AND payload_json LIKE ${`%${input.taskId}%`}
    `.pipe(
      Effect.mapError((cause) =>
        outputError(input.taskId, "Failed to look up the background task.", cause),
      ),
    );
    for (const row of rows) {
      const item = Option.getOrNull(decodeTaskItem(row.payload_json));
      if (item === null) continue;
      if (item.type === "dynamic_tool") {
        if (item.output.taskId === input.taskId) return item.input.command;
        continue;
      }
      const output = item.output ?? "";
      if (
        item.nativeItemRef?.nativeId === input.taskId ||
        output.includes(`"backgroundTaskId":"${input.taskId}"`) ||
        backgroundTaskOutputPath(output, input.taskId) !== null
      ) {
        return item.input;
      }
    }
    return null;
  },
);

/** Most log files a follow terminal adds beside the task's own output. */
const MAX_WATCHED_LOGS = 4;

const isRegularFile = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.isFile(),
    () => false,
  );

/** The first few of `paths` that are regular files now. */
async function existingRegularFiles(paths: ReadonlyArray<string>): Promise<Array<string>> {
  const files: Array<string> = [];
  for (const path of paths) {
    if (files.length === MAX_WATCHED_LOGS) break;
    if (await isRegularFile(path)) files.push(path);
  }
  return files;
}

/** Carries the output path into the follow terminal, so the typed command never shows it. */
const FOLLOW_OUTPUT_ENV = "T3CODE_BACKGROUND_OUTPUT";
/** Same for the logs the task's command watches or writes: `T3CODE_WATCHED_LOG_1`, `_2`, … */
const WATCHED_LOG_ENV = "T3CODE_WATCHED_LOG_";

/**
 * Opens a terminal that follows a background shell's output: a normal shell with `tail -F` typed
 * into it, so Ctrl+C leaves a usable shell. The first screen is capped like the viewer's tail.
 *
 * Agents often start the real job detached and background only a silent wait on its log, so the
 * tab also follows the existing files the task's command reads or writes (`watchedLogPaths`),
 * relative ones resolved against the terminal's cwd, the thread's workspace.
 */
export const followBackgroundTaskInTerminal = Effect.fn("terminal.followBackgroundTask")(function* (
  input: TerminalFollowBackgroundTaskInput,
) {
  const { taskId, ...openInput } = input;
  // ponytail: POSIX shells only (bash, zsh, fish, sh); Windows hosts fall back to the viewer.
  if (yield* isHostWindows) {
    return yield* outputError(taskId, "Following a shell in a terminal needs a POSIX host.");
  }
  const { path, appearsLater } = yield* resolveBackgroundTaskOutputFile(input);
  // A Codex log appears with the command's first output; a missing Claude file is gone for good.
  const followable =
    appearsLater ||
    (yield* Effect.promise(() =>
      NodeFSP.access(path).then(
        () => true,
        () => false,
      ),
    ));
  const command = yield* findBackgroundTaskCommand(input);
  const watched =
    command === null
      ? []
      : yield* Effect.promise(() =>
          existingRegularFiles(
            watchedLogPaths(command, input.cwd, NodeOS.homedir()).filter((file) => file !== path),
          ),
        );
  const watchedEnv = Object.fromEntries(
    watched.map((file, index) => [`${WATCHED_LOG_ENV}${index + 1}`, file]),
  );
  const followed = [...(followable ? [FOLLOW_OUTPUT_ENV] : []), ...Object.keys(watchedEnv)];
  const terminals = yield* TerminalManager;
  const snapshot = yield* terminals.open({
    ...openInput,
    env: { ...openInput.env, [FOLLOW_OUTPUT_ENV]: path, ...watchedEnv },
  });
  // A leading space keeps the line out of shell history where that is configured.
  yield* terminals.write({
    threadId: input.threadId,
    terminalId: input.terminalId,
    data:
      followed.length > 0
        ? ` tail -c ${BACKGROUND_TASK_OUTPUT_TAIL_BYTES} -F ${followed.map((name) => `"$${name}"`).join(" ")}\r`
        : ` echo 'This background shell no longer has an output file.'\r`,
  });
  return snapshot;
});
