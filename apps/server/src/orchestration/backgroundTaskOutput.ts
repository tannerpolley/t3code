// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live, read-only output tail for a thread's background process.
 *
 * Claude runs `run_in_background` Bash commands with output redirected to a file and reports the
 * path in the tool result ("Output is being written to: <path>"), which the thread's
 * command_execution turn item already stores. The server re-finds that path from the thread's own
 * items, so a client can only name a task, never a path. Nothing else exposes this output: the
 * SDK's background task messages carry ids only until `task_notification.output_file` at the end.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import {
  type OrchestrationV2BackgroundTaskOutputChunk,
  OrchestrationV2BackgroundTaskOutputError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

export const subscribeBackgroundTaskOutput = Effect.fn(
  "orchestration.subscribeBackgroundTaskOutput",
)(function* (input: { readonly threadId: ThreadId; readonly taskId: string }) {
  const sql = yield* SqlClient.SqlClient;
  const fail = (message: string, cause?: unknown) =>
    new OrchestrationV2BackgroundTaskOutputError({
      taskId: input.taskId,
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId}
        AND type = 'command_execution'
        AND payload_json LIKE ${`%${input.taskId}.output%`}
    `.pipe(Effect.mapError((cause) => fail("Failed to look up the background task.", cause)));
  const path = rows
    .map((row) => {
      const output: unknown = JSON.parse(row.payload_json).output;
      return typeof output === "string" ? backgroundTaskOutputPath(output, input.taskId) : null;
    })
    .find((candidate) => candidate !== null);
  if (path === undefined || path === null) {
    return yield* fail("This background task has no output file to show.");
  }
  const state = initialOutputTailState();
  // ponytail: 1s stat polling per open viewer; switch to fs.watch if viewers get numerous.
  return Stream.fromEffectSchedule(
    Effect.tryPromise({
      try: () => readOutputTail(path, state),
      catch: (cause) => fail("Background task output is no longer readable.", cause),
    }),
    Schedule.spaced("1 second"),
  ).pipe(Stream.filter((chunk) => chunk !== null));
});
