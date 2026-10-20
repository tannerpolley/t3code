import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadProcessesInput = Schema.Struct({ threadId: ThreadId });
export type ThreadProcessesInput = typeof ThreadProcessesInput.Type;

/** A command item a thread's agent is running now. */
export const ThreadRunningCommand = Schema.Struct({
  /** The provider's id for the command; Stop and the output popup name it by this. */
  taskId: TrimmedNonEmptyString,
  command: Schema.String,
  /** What the command mostly runs (`classifyShellCommand`), for its row's icon. */
  commandKind: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  /**
   * Codex streams a running command's output to the server and can stop it. Claude reports a
   * foreground command's output only when it ends, and cannot stop just that command.
   */
  followable: Schema.Boolean,
});
export type ThreadRunningCommand = typeof ThreadRunningCommand.Type;

export const ThreadProcessMember = Schema.Struct({
  pid: PositiveInt,
  commandLine: Schema.String,
  startedAt: Schema.String,
  cpuPercent: Schema.Number,
  residentBytes: NonNegativeInt,
});
export type ThreadProcessMember = typeof ThreadProcessMember.Type;

/** Processes a thread's commands and tasks spawned that share one command shape. */
export const ThreadProcessGroup = Schema.Struct({
  /** The kind of program the processes run, such as `python` or `node`. */
  label: Schema.String,
  /** One member's full command line, for hover. */
  commandLine: Schema.String,
  count: PositiveInt,
  cpuPercent: Schema.Number,
  residentBytes: NonNegativeInt,
  /** Earliest start across all members, including those beyond the member limit. */
  startedAt: Schema.optionalKey(Schema.String),
  /** Up to 20 members; older servers omit these details. */
  members: Schema.optionalKey(Schema.Array(ThreadProcessMember)),
});
export type ThreadProcessGroup = typeof ThreadProcessGroup.Type;

/** What a thread is running now, sampled on request. */
export const ThreadProcesses = Schema.Struct({
  commands: Schema.Array(ThreadRunningCommand),
  /** Every background task and command of the thread that is still running. */
  runningTaskIds: Schema.Array(Schema.String),
  /** Every group, largest first; the sidebar lists the first few. */
  processGroups: Schema.Array(ThreadProcessGroup),
  /** Always 0: web tabs loaded before the sidebar capped groups itself still require it. */
  hiddenProcessGroupCount: NonNegativeInt,
  /** Usage of every process the commands and tasks run or spawned, listed or not. */
  usage: Schema.optionalKey(
    Schema.Struct({ cpuPercent: Schema.Number, residentBytes: NonNegativeInt }),
  ),
});
export type ThreadProcesses = typeof ThreadProcesses.Type;
