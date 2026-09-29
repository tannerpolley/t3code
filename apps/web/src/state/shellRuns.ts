import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "@t3tools/client-runtime/state/terminal";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { create } from "zustand";

import {
  EMPTY_SHELL_RUN_OUTPUT,
  feedShellRunOutput,
  formatShellRunMessage,
  SHELL_RUN_TYPED_LINE,
  SHELL_RUN_WRAPPER,
  type ShellRunOutput,
} from "../lib/shellRun";
import { newMessageId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadTerminalLaunch, terminalEnvironment } from "./terminal";
import { threadEnvironment } from "./threads";

export interface ShellRun {
  readonly runId: string;
  readonly threadRef: ScopedThreadRef;
  /** Each run is its own terminal session, which the thread's terminal drawer can show. */
  readonly terminalId: string;
  /** `running` until the command exits (`done`) or its session ends first (`ended`). */
  readonly status: "running" | "done" | "ended";
  readonly output: ShellRunOutput;
  readonly error: string | null;
}

/**
 * Runs of assistant code blocks in this client, by block (see `shellRunBlockKey`). Nothing here
 * persists: after a reload the sent message keeps the record.
 */
export const useShellRunStore = create<{ readonly runs: Readonly<Record<string, ShellRun>> }>()(
  () => ({ runs: {} }),
);

export function shellRunBlockKey(
  threadRef: ScopedThreadRef,
  messageId: string,
  blockOffset: number,
): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, messageId, blockOffset]);
}

/** Applies a change to a block's run, unless a newer run of that block replaced it. */
function updateRun(blockKey: string, runId: string, change: Partial<ShellRun>): void {
  useShellRunStore.setState((state) => {
    const run = state.runs[blockKey];
    if (run?.runId !== runId) return state;
    return { runs: { ...state.runs, [blockKey]: { ...run, ...change } } };
  });
}

function failureMessage(failure: { readonly cause: Cause.Cause<unknown> }): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * Runs `command` in a new hidden terminal session of the thread (in its worktree, else its
 * project root), follows the output, and when the command exits sends the thread a message with
 * the command, exit code and output: it starts a turn when the agent is idle and queues behind
 * the active one otherwise.
 */
export async function startShellRun(input: {
  readonly blockKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly command: string;
}): Promise<void> {
  const { blockKey, threadRef, command } = input;
  const runId = randomUUID();
  const terminalId = `run-${runId}`;
  useShellRunStore.setState((state) => ({
    runs: {
      ...state.runs,
      [blockKey]: {
        runId,
        threadRef,
        terminalId,
        status: "running",
        output: EMPTY_SHELL_RUN_OUTPUT,
        error: null,
      },
    },
  }));
  const end = (change: Partial<ShellRun>) =>
    updateRun(blockKey, runId, { status: "ended", ...change });

  const launch = readThreadTerminalLaunch(threadRef);
  if (!launch) {
    end({ error: "This thread's project is not available." });
    return;
  }
  const target = { environmentId: threadRef.environmentId };
  const session = { threadId: threadRef.threadId, terminalId };
  const opened = await runAtomCommand(
    appAtomRegistry,
    terminalEnvironment.open,
    {
      ...target,
      input: {
        ...session,
        ...launch.open,
        env: {
          ...launch.open.env,
          T3CODE_RUN_SCRIPT: command,
          T3CODE_RUN_WRAPPER: SHELL_RUN_WRAPPER,
        },
      },
    },
    { reportFailure: false },
  );
  const written =
    opened._tag === "Failure"
      ? opened
      : await runAtomCommand(
          appAtomRegistry,
          terminalEnvironment.write,
          { ...target, input: { ...session, data: SHELL_RUN_TYPED_LINE } },
          { reportFailure: false },
        );
  if (written._tag === "Failure") {
    end({ error: failureMessage(written) });
    return;
  }

  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let output = EMPTY_SHELL_RUN_OUTPUT;
  let unsubscribe: (() => void) | null = null;
  let finished = false;
  const finish = () => {
    finished = true;
    unsubscribe?.();
  };
  // The attach stream starts with the session's history, so output printed before this
  // subscription, or across a reconnect, is read again from the start.
  unsubscribe = appAtomRegistry.subscribe(
    terminalEnvironment.attach({ ...target, input: session }),
    (result) => {
      if (finished) return;
      const buffer = Option.getOrNull(AsyncResult.value(result));
      if (buffer !== null) {
        const update = readTerminalOutputUpdate(buffer.output, cursor);
        cursor = update.cursor;
        if (update.type === "reset")
          output = feedShellRunOutput(EMPTY_SHELL_RUN_OUTPUT, update.data);
        else if (update.type === "append") output = feedShellRunOutput(output, update.data);
      }
      if (output.done) {
        finish();
        updateRun(blockKey, runId, { status: "done", output });
        void sendShellRunResult({ blockKey, runId, threadRef, command, output });
      } else if (
        result._tag === "Failure" ||
        (buffer !== null &&
          buffer.version > 0 &&
          (buffer.status === "exited" || buffer.status === "closed" || buffer.status === "error"))
      ) {
        finish();
        end({ output });
      } else {
        updateRun(blockKey, runId, { output });
      }
    },
    { immediate: true },
  );
  if (finished) unsubscribe();
}

async function sendShellRunResult(input: {
  readonly blockKey: string;
  readonly runId: string;
  readonly threadRef: ScopedThreadRef;
  readonly command: string;
  readonly output: ShellRunOutput;
}): Promise<void> {
  const launch = readThreadTerminalLaunch(input.threadRef);
  if (!launch) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId: input.threadRef.environmentId,
      input: {
        threadId: input.threadRef.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: formatShellRunMessage({
            command: input.command,
            exitCode: input.output.exitCode ?? 0,
            output: input.output,
          }),
          attachments: [],
        },
        runtimeMode: launch.thread.runtimeMode,
        interactionMode: launch.thread.interactionMode,
        // Never steer or restart the agent's work: wait behind it, or start a turn when idle.
        dispatchMode: "queue",
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    updateRun(input.blockKey, input.runId, {
      error: `The output was not sent to the agent: ${failureMessage(result)}`,
    });
  }
}

/** Sends Ctrl+C to the run's session; the command then exits and reports like any other. */
export function stopShellRun(run: ShellRun): void {
  void runAtomCommand(
    appAtomRegistry,
    terminalEnvironment.write,
    {
      environmentId: run.threadRef.environmentId,
      input: { threadId: run.threadRef.threadId, terminalId: run.terminalId, data: "\u0003" },
    },
    { reportFailure: false },
  );
}
