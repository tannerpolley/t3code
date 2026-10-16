// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live, read-only output of a thread's background shell or Claude monitor, for the output popup.
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
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import {
  type OrchestrationV2BackgroundTaskResourceUsage,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2BackgroundTaskOutputChunk,
  OrchestrationV2BackgroundTaskOutputError,
  type ResourceTelemetryProcess,
  ThreadId,
  type ThreadProcesses,
  type ThreadProcessesInput,
  type OrchestrationV2StopBackgroundTaskInput,
  type OrchestrationV2StopBackgroundTaskError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { findBackgroundTaskSession, stopBackgroundTask } from "./BackgroundTaskStop.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import { codexBackgroundTaskLogPath, reportedTaskOutputPaths } from "./backgroundTaskFiles.ts";
import {
  attributeCommandProcesses,
  groupSpawnedProcesses,
  runningThreadWork,
} from "./threadProcesses.ts";

/** Task-scoped output, usage, running processes and Stop, shared by transports. */
export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  {
    readonly subscribeOutput: (input: {
      readonly threadId: string;
      readonly taskId: string;
    }) => Effect.Effect<
      Stream.Stream<
        OrchestrationV2BackgroundTaskOutputChunk,
        OrchestrationV2BackgroundTaskOutputError
      >,
      OrchestrationV2BackgroundTaskOutputError
    >;
    readonly stop: (
      input: OrchestrationV2StopBackgroundTaskInput,
    ) => Effect.Effect<void, OrchestrationV2StopBackgroundTaskError>;
    readonly resourceUsage: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationV2BackgroundTaskResourceUsage>>;
    readonly processes: (input: ThreadProcessesInput) => Effect.Effect<ThreadProcesses>;
  }
>()("t3/orchestration-v2/backgroundTaskOutput/BackgroundTasks") {}

/** Largest tail sent at once; the client keeps a buffer of the same size. */
const BACKGROUND_TASK_OUTPUT_TAIL_BYTES = 200 * 1024;

// Claude task ids are short alphanumerics; anything else cannot name a reported task file.
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The output file Claude reported for `taskId` in a background Bash tool result, or null. */
export function backgroundTaskOutputPath(itemOutput: string, taskId: string): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  return reportedTaskOutputPaths(itemOutput).find((entry) => entry.taskId === taskId)?.path ?? null;
}

interface OutputTailState {
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
      nativeItemRef: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ nativeId: Schema.String, driver: Schema.optional(Schema.String) }),
        ),
      ),
    }),
  ),
);

/**
 * The output file of one of `threadId`'s background shells or Claude monitors. `appearsLater`
 * marks a Codex log, which exists only once the command has printed something.
 */
const resolveBackgroundTaskOutputFile = Effect.fn("orchestration.resolveBackgroundTaskOutputFile")(
  function* (input: { readonly threadId: string; readonly taskId: string }) {
    const sql = yield* SqlClient.SqlClient;
    const { logsDir } = yield* ServerConfig.ServerConfig;
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
      // Stored items name their provider on `nativeItemRef`; older shapes put it at the top level.
      const driver = item.nativeItemRef?.driver ?? item.driver;
      if (driver === "codex" && item.nativeItemRef?.nativeId === input.taskId) {
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
  },
);

const isMissingFile = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const subscribeBackgroundTaskOutput = Effect.fn("orchestration.subscribeBackgroundTaskOutput")(
  function* (input: { readonly threadId: string; readonly taskId: string }) {
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
  },
);

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
const findBackgroundTaskCommand = Effect.fn("orchestration.findBackgroundTaskCommand")(
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

type BackgroundTaskUsageProcess = Pick<
  ResourceTelemetryProcess,
  "identity" | "ppid" | "command" | "cpuPercent" | "residentBytes"
>;

/** Usage from one process matching the task command and its sampled descendants. */
export function aggregateBackgroundTaskProcessUsage(input: {
  readonly processes: ReadonlyArray<BackgroundTaskUsageProcess>;
  readonly serverPid: number;
  readonly command: string | null;
  readonly commandKind?: string;
}): { readonly cpuPercent: number; readonly residentBytes: number } | null {
  const attributed = attributeCommandProcesses(input);
  if (attributed === null) return null;
  let cpuPercent = 0;
  let residentBytes = 0;
  for (const process of input.processes) {
    if (!attributed.tree.has(process.identity.pid)) continue;
    cpuPercent += process.cpuPercent;
    residentBytes += process.residentBytes;
  }
  return { cpuPercent, residentBytes };
}

/** Each task with the command that started it, looked up when the task does not carry one. */
const withTaskCommands = Effect.fn("orchestration.withTaskCommands")(function* (
  tasks: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly task: OrchestrationV2PendingBackgroundTask;
  }>,
) {
  return yield* Effect.forEach(
    tasks,
    ({ threadId, task }) =>
      Effect.gen(function* () {
        const command =
          task.command ??
          (yield* findBackgroundTaskCommand({ threadId, taskId: task.taskId }).pipe(
            Effect.orElseSucceed(() => null),
          ));
        return { threadId, task, command };
      }),
    { concurrency: 4 },
  );
});

/** A fresh sample of the processes under this server, or null while the monitor is unavailable. */
const sampleProcesses = Effect.gen(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const current = yield* Effect.option(telemetry.refresh);
  return Option.isNone(current) || current.value.health.native.status !== "healthy"
    ? null
    : current.value.processes;
});

/** One sampled process tree for the running tasks of the requested threads. */
const readBackgroundTaskResourceUsage = Effect.fn("orchestration.readBackgroundTaskResourceUsage")(
  function* (input: {
    readonly threads: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    }>;
    readonly sample: typeof sampleProcesses;
  }) {
    const tasks = input.threads.flatMap(({ threadId, tasks }) =>
      tasks.map((task) => ({ threadId, task })),
    );
    if (tasks.length === 0) return [];
    const processes = yield* input.sample;
    if (processes === null) {
      return tasks.map(({ threadId, task }) => ({
        threadId,
        taskId: task.taskId,
        cpuPercent: null,
        residentBytes: null,
      }));
    }
    return (yield* withTaskCommands(tasks)).map(({ threadId, task, command }) => {
      const usage = aggregateBackgroundTaskProcessUsage({
        processes,
        serverPid: process.pid,
        command,
        ...(task.commandKind === undefined ? {} : { commandKind: task.commandKind }),
      });
      return {
        threadId,
        taskId: task.taskId,
        cpuPercent: usage?.cpuPercent ?? null,
        residentBytes: usage?.residentBytes ?? null,
      };
    });
  },
);

/** The tasks a thread's provider threads list, from the active one when the thread names it. */
const rosterOf = (records: {
  readonly thread: { readonly activeProviderThreadId: string | null };
  readonly providerThreads: ReadonlyArray<{
    readonly id: string;
    readonly pendingBackgroundTasks?:
      | ReadonlyArray<OrchestrationV2PendingBackgroundTask>
      | undefined;
  }>;
}) =>
  records.providerThreads
    .filter(
      (providerThread) =>
        records.thread.activeProviderThreadId === null ||
        providerThread.id === records.thread.activeProviderThreadId,
    )
    .flatMap((providerThread) => providerThread.pendingBackgroundTasks ?? []);

/** See `runningThreadWork`; the thread's running command items and the rosters it can use. */
const readRunningThreadWork = Effect.fn("orchestration.readRunningThreadWork")(function* (
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const own = yield* threads.getThreadRecords(threadId, ["providerThreads", "turnItems"], {
    turnItemTypes: ["command_execution"],
    turnItemStatuses: ["pending", "running", "waiting"],
  });
  const parentId = own.thread.lineage.parentThreadId;
  const parent =
    parentId === null ? null : yield* threads.getThreadRecords(parentId, ["providerThreads"]);
  const runIds = [...new Set(own.turnItems.flatMap((item) => item.runId ?? []))];
  const { runs } =
    runIds.length === 0
      ? { runs: [] }
      : yield* threads.getThreadRecords(threadId, ["runs"], { runIds });
  return runningThreadWork({
    threadId,
    ownRoster: rosterOf(own),
    parentRoster: parent === null ? [] : rosterOf(parent),
    turnItems: own.turnItems,
    runs,
  });
});

const NO_THREAD_PROCESSES: ThreadProcesses = {
  commands: [],
  runningTaskIds: [],
  processGroups: [],
};

const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    | SqlClient.SqlClient
    | ServerConfig.ServerConfig
    | ThreadManagement.ThreadManagementService
    | ProviderSessionManager.ProviderSessionManagerV2
    | ResourceTelemetry.ResourceTelemetry
  >();
  // Every thread's poll would otherwise take its own sample, and the monitor samples one at a
  // time; callers within a poll interval share one, waiting on it while it is taken.
  const sample = yield* Effect.cachedWithTTL(
    sampleProcesses.pipe(Effect.provide(context)),
    "4 seconds",
  );
  // A thread that cannot be read runs nothing the caller can show.
  const runningWork = (threadId: ThreadId) =>
    readRunningThreadWork(threadId).pipe(
      Effect.provide(context),
      Effect.orElseSucceed(() => null),
    );
  const resourceUsage = Effect.fn("BackgroundTasks.resourceUsage")(function* (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) {
    const records = yield* Effect.forEach(
      [...new Set(input.threadIds)],
      (threadId) =>
        runningWork(threadId).pipe(Effect.map((work) => ({ threadId, tasks: work?.tasks ?? [] }))),
      { concurrency: 2 },
    );
    return yield* readBackgroundTaskResourceUsage({ threads: records, sample }).pipe(
      Effect.provide(context),
    );
  });
  const processes = Effect.fn("BackgroundTasks.processes")(function* (input: ThreadProcessesInput) {
    const work = yield* runningWork(input.threadId);
    if (work === null || work.tasks.length === 0) return NO_THREAD_PROCESSES;
    const sampled = yield* sample;
    const commands =
      sampled === null
        ? []
        : yield* withTaskCommands(
            work.tasks.map((task) => ({ threadId: input.threadId, task })),
          ).pipe(Effect.provide(context));
    const { groups, usage } = groupSpawnedProcesses({
      processes: sampled ?? [],
      serverPid: process.pid,
      commands: commands.map(({ task, command }) => ({
        command,
        ...(task.commandKind === undefined ? {} : { commandKind: task.commandKind }),
      })),
    });
    return {
      commands: work.commands,
      runningTaskIds: work.tasks.map((task) => task.taskId),
      processGroups: groups,
      usage,
    };
  });
  return BackgroundTasks.of({
    subscribeOutput: (input) => subscribeBackgroundTaskOutput(input).pipe(Effect.provide(context)),
    stop: (input) => stopBackgroundTask(input).pipe(Effect.provide(context)),
    resourceUsage,
    processes,
  });
});
export const layer = Layer.effect(BackgroundTasks, make);
