// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live, read-only output of a thread's background shell, for the popover viewer and for a
 * terminal tab that follows it.
 *
 * Claude runs `run_in_background` Bash commands with output redirected to a file and reports the
 * path in the tool result ("Output is being written to: <path>"), which the thread's
 * command_execution turn item already stores. The SDK's background task messages carry ids only
 * until `task_notification.output_file` at the end.
 *
 * Codex streams command output as `item/commandExecution/outputDelta` notifications; the Codex
 * adapter appends them to a server-owned log per command (`makeBackgroundTaskLogWriter`).
 *
 * Either way the server re-finds the file from the thread's own items, so a client can only name
 * a task, never a path.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import {
  type OrchestrationV2BackgroundTaskOutputChunk,
  OrchestrationV2BackgroundTaskOutputError,
  type TerminalFollowBackgroundTaskInput,
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
import { TerminalManager } from "../terminal/Manager.ts";

/** Largest tail sent at once; the client keeps a buffer of the same size. */
export const BACKGROUND_TASK_OUTPUT_TAIL_BYTES = 200 * 1024;

// Claude task ids are short alphanumerics; anything else cannot name a reported task file.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The output file Claude reported for `taskId` in a background Bash tool result, or null.
 * Only an absolute, normalized `<dir>/tasks/<taskId>.output` path is accepted.
 */
export function backgroundTaskOutputPath(itemOutput: string, taskId: string): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  const match = new RegExp(
    `Output is being written to: (.+?[\\\\/]tasks[\\\\/]${taskId}\\.output)(?=\\.?\\s|\\.?$)`,
  ).exec(itemOutput);
  const path = match?.[1];
  if (path === undefined || !NodePath.isAbsolute(path)) return null;
  return NodePath.normalize(path) === path ? path : null;
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
 * The output file of one of `threadId`'s background shells. `appearsLater` marks a Codex log,
 * which exists only once the command has printed something.
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
  return yield* outputError(input.taskId, "This background task has no output file to show.");
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

/** Carries the output path into the follow terminal, so the typed command never shows it. */
const FOLLOW_OUTPUT_ENV = "T3CODE_BACKGROUND_OUTPUT";

/**
 * Opens a terminal that follows a background shell's output: a normal shell with `tail -F` typed
 * into it, so Ctrl+C leaves a usable shell. The first screen is capped like the viewer's tail.
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
  const terminals = yield* TerminalManager;
  const snapshot = yield* terminals.open({
    ...openInput,
    env: { ...openInput.env, [FOLLOW_OUTPUT_ENV]: path },
  });
  // A leading space keeps the line out of shell history where that is configured.
  yield* terminals.write({
    threadId: input.threadId,
    terminalId: input.terminalId,
    data: followable
      ? ` tail -c ${BACKGROUND_TASK_OUTPUT_TAIL_BYTES} -F "$${FOLLOW_OUTPUT_ENV}"\r`
      : ` echo 'This background shell no longer has an output file.'\r`,
  });
  return snapshot;
});
