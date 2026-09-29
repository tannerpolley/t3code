// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderThreadId,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterAll, assert, describe, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import {
  aggregateBackgroundTaskProcessUsage,
  backgroundTaskOutputPath,
  codexBackgroundTaskLogPath,
  followBackgroundTaskInTerminal,
  initialOutputTailState,
  makeBackgroundTaskLogWriter,
  readOutputTail,
} from "./backgroundTaskOutput.ts";

const notice = (taskId: string, path: string) =>
  `Command running in background with ID: ${taskId}. Output is being written to: ${path}. You will be notified when it completes. To check interim output, use Read on that file path.`;

describe("backgroundTaskOutputPath", () => {
  const path = "/tmp/claude-1000/-home-me-project/3eb6d2ff/tasks/bzdkaire7.output";

  it("returns the file Claude reported for that task", () => {
    assert.equal(backgroundTaskOutputPath(notice("bzdkaire7", path), "bzdkaire7"), path);
    // A foreground command that hit its timeout reports the same path in different words.
    const moved = `Command did not complete within its 120s timeout and was moved to the background (ID: bzdkaire7). Output is being written to: ${path}. You will be notified when it completes.`;
    assert.equal(backgroundTaskOutputPath(moved, "bzdkaire7"), path);
  });

  it("serves nothing but the named task's absolute tasks/<id>.output file", () => {
    assert.isNull(backgroundTaskOutputPath(notice("bzdkaire7", path), "other1"));
    assert.isNull(backgroundTaskOutputPath(notice("x", "/home/me/.ssh/id_rsa"), "x"));
    assert.isNull(backgroundTaskOutputPath(notice("x", "relative/tasks/x.output"), "x"));
    assert.isNull(
      backgroundTaskOutputPath(notice("x", "/tmp/tasks/../../etc/tasks/x.output"), "x"),
    );
    assert.isNull(backgroundTaskOutputPath(notice("../x", "/tmp/tasks/../x.output"), "../x"));
  });
});

describe("aggregateBackgroundTaskProcessUsage", () => {
  const process = (
    pid: number,
    ppid: number,
    cpuPercent: number,
    residentBytes: number,
    command = `process-${pid}`,
  ) => ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    command,
    cpuPercent,
    residentBytes,
  });
  const taskTree = (command: string) => [
    process(1, 0, 99, 999, "server"),
    process(10, 1, 10, 200, "provider"),
    process(20, 10, 1, 10, command),
    process(21, 20, 17.5, 90, "task child"),
    process(11, 10, 2, 300, "other child"),
    process(30, 1, 3, 400, "unrelated process"),
  ];

  it("sums only the unique process tree matching the task command", () => {
    assert.deepEqual(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree("python fit.py"),
        serverPid: 1,
        command: "python fit.py",
      }),
      { cpuPercent: 18.5, residentBytes: 100 },
    );
  });

  it("counts a wait target only when the sampled process belongs to that task tree", () => {
    assert.deepEqual(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree("while kill -0 21; do sleep 5; done"),
        serverPid: 1,
        command: "while kill -0 21; do sleep 5; done",
        commandKind: "watcher",
      }),
      { cpuPercent: 18.5, residentBytes: 100 },
    );
    assert.isNull(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree("tail --pid=30 -f /dev/null"),
        serverPid: 1,
        command: "tail --pid=30 -f /dev/null",
        commandKind: "watcher",
      }),
    );
    assert.isNull(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree("while kill -0 $PID; do sleep 5; done"),
        serverPid: 1,
        command: "while kill -0 $PID; do sleep 5; done",
        commandKind: "watcher",
      }),
    );
  });

  it("returns no usage without a unique command match", () => {
    assert.isNull(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree("python fit.py"),
        serverPid: 1,
        command: "npm test",
      }),
    );
    assert.isNull(
      aggregateBackgroundTaskProcessUsage({
        processes: [...taskTree("python fit.py"), process(40, 1, 7, 80, "python fit.py")],
        serverPid: 1,
        command: "python fit.py",
      }),
    );
  });
});

describe("readOutputTail", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-output-"));
  const file = NodePath.join(dir, "task.output");
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("sends the capped tail first, then only what was appended", async () => {
    NodeFS.writeFileSync(file, "0123456789");
    const state = initialOutputTailState();
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "6789", reset: true });
    assert.isNull(await readOutputTail(file, state, 4));
    NodeFS.appendFileSync(file, "ab");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "ab", reset: false });
    NodeFS.appendFileSync(file, "cdefgh");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "efgh", reset: true });
    NodeFS.writeFileSync(file, "new");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "new", reset: true });
  });

  it("keeps a multi-byte character split across reads intact", async () => {
    NodeFS.writeFileSync(file, Buffer.from("é").subarray(0, 1));
    const state = initialOutputTailState();
    assert.deepEqual(await readOutputTail(file, state), { text: "", reset: true });
    NodeFS.appendFileSync(file, Buffer.from("é").subarray(1));
    assert.deepEqual(await readOutputTail(file, state), { text: "é", reset: false });
  });
});

describe("makeBackgroundTaskLogWriter", () => {
  const logsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-logs-"));
  afterAll(() => NodeFS.rmSync(logsDir, { recursive: true, force: true }));
  const read = (path: string) => NodeFS.readFileSync(path, "utf8");

  effectIt.effect(
    "appends a command's output in order and keeps only the newest past the cap",
    () =>
      Effect.gen(function* () {
        const logs = yield* makeBackgroundTaskLogWriter(logsDir, 64);
        const path = codexBackgroundTaskLogPath(logsDir, "thread-a", "item-1");
        const chunks = Array.from({ length: 30 }, (_, index) => String(index).padStart(2, "0"));
        for (const chunk of chunks) yield* logs.append("thread-a", "item-1", chunk);
        yield* logs.drain("thread-a", "item-1");
        assert.equal(read(path), chunks.join(""));

        yield* logs.append("thread-a", "item-1", "xxxxxxxxxx");
        yield* logs.drain("thread-a", "item-1");
        assert.equal(read(path), `${chunks.join("")}xxxxxxxxxx`.slice(-32));

        yield* logs.remove("thread-a", "item-1");
        yield* logs.drain("thread-a", "item-1");
        assert.isFalse(NodeFS.existsSync(path));
      }).pipe(Effect.scoped),
  );

  effectIt.effect("deletes the logs of commands still running when the session closes", () =>
    Effect.gen(function* () {
      const path = codexBackgroundTaskLogPath(logsDir, "thread-a", "item-2");
      yield* Effect.gen(function* () {
        const logs = yield* makeBackgroundTaskLogWriter(logsDir);
        yield* logs.append("thread-a", "item-2", "still running");
        yield* logs.drain("thread-a", "item-2");
        assert.equal(read(path), "still running");
      }).pipe(Effect.scoped);
      assert.isFalse(NodeFS.existsSync(path));
    }),
  );
});

describe("followBackgroundTaskInTerminal", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-follow-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const claudeFile = NodePath.join(dir, "tasks", "bclaude1.output");
  NodeFS.mkdirSync(NodePath.dirname(claudeFile));
  NodeFS.writeFileSync(claudeFile, "hello\n");

  const opened: Array<TerminalOpenInput> = [];
  const written: Array<string> = [];
  const snapshot = (input: TerminalOpenInput): TerminalSessionSnapshot => ({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: input.terminalId,
    updatedAt: "2026-09-28T00:00:00.000Z",
  });
  // One live Claude session, whose roster holds thread-m's running monitor.
  let sessionTasksDir: string | null = null;
  const monitorThread = {
    id: ProviderThreadId.make("provider-thread-m"),
    providerSessionId: ProviderSessionId.make("provider-session-m"),
    pendingBackgroundTasks: [{ taskId: "bmon1", taskType: "local_bash" }],
  };
  const layer = Layer.mergeAll(
    SqlitePersistenceMemory,
    ServerConfig.layerTest(dir, { prefix: "bg-task-follow-config-" }),
    Layer.mock(TerminalManager)({
      open: (input) => Effect.sync(() => (opened.push(input), snapshot(input))),
      write: (input) => Effect.sync(() => void written.push(input.data)),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadRecords: (threadId) =>
        Effect.succeed({
          thread: { lineage: { parentThreadId: null } },
          providerThreads: threadId === "thread-m" ? [monitorThread] : [],
          turnItems: [],
        } as never),
    }),
    Layer.mock(ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            driver: "claudeAgent",
            backgroundTaskOutputDir: () => Effect.sync(() => sessionTasksDir),
          } as never),
        ),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  const insertItem = (id: string, threadId: string, payload: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, 1, 'command_execution', 'running', '', ${payload})
      `;
    });
  const follow = (threadId: string, taskId: string) =>
    followBackgroundTaskInTerminal({ threadId, terminalId: `bg-${taskId}`, cwd: dir, taskId });

  effectIt.effect(
    "follows a Claude task's file or a Codex task's log, and only the thread's own tasks",
    () =>
      Effect.gen(function* () {
        const { logsDir } = yield* ServerConfig.ServerConfig;
        yield* insertItem(
          "item-claude",
          "thread-a",
          `{"driver":"claudeAgent","output":"${notice("bclaude1", claudeFile)}"}`,
        );
        yield* insertItem(
          "item-codex",
          "thread-a",
          `{"nativeItemRef":{"driver":"codex","nativeId":"call_codex1"}}`,
        );

        yield* follow("thread-a", "bclaude1");
        yield* follow("thread-a", "call_codex1");
        assert.deepEqual(
          opened.map((input) => input.env?.T3CODE_BACKGROUND_OUTPUT),
          [claudeFile, codexBackgroundTaskLogPath(logsDir, "thread-a", "call_codex1")],
        );
        // The Codex log doesn't exist until the command prints; tail waits for it.
        assert.deepEqual(written, [
          ` tail -c 204800 -F "$T3CODE_BACKGROUND_OUTPUT"\r`,
          ` tail -c 204800 -F "$T3CODE_BACKGROUND_OUTPUT"\r`,
        ]);

        const otherThread = yield* Effect.exit(follow("thread-b", "bclaude1"));
        const unknown = yield* Effect.exit(follow("thread-a", "nope"));
        assert.equal(otherThread._tag, "Failure");
        assert.equal(unknown._tag, "Failure");
        assert.lengthOf(opened, 2);

        NodeFS.rmSync(claudeFile);
        yield* follow("thread-a", "bclaude1");
        assert.equal(
          written.at(-1),
          ` echo 'This background shell no longer has an output file.'\r`,
        );
      }).pipe(Effect.provide(layer)),
  );

  effectIt.effect(
    "follows a running Claude monitor in the directory its live session reported, and says what's missing",
    () =>
      Effect.gen(function* () {
        const messageOf = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
          Exit.isFailure(exit)
            ? (Option.getOrNull(Cause.findErrorOption(exit.cause))?.message ?? "")
            : "";
        // A Monitor's tool result names no file, and until Claude reports a task path neither
        // does anything else in its session.
        const unreported = yield* Effect.exit(follow("thread-m", "bmon1"));
        assert.match(messageOf(unreported), /has not reported where this session keeps/);

        // Claude writes each monitor event, as it happens, to <session>/tasks/<taskId>.output.
        sessionTasksDir = NodePath.join(dir, "tasks");
        const monitorFile = NodePath.join(sessionTasksDir, "bmon1.output");
        NodeFS.writeFileSync(monitorFile, "event 1\nevent 2\n");
        yield* follow("thread-m", "bmon1");
        assert.equal(opened.at(-1)?.env?.T3CODE_BACKGROUND_OUTPUT, monitorFile);
        assert.equal(written.at(-1), ` tail -c 204800 -F "$T3CODE_BACKGROUND_OUTPUT"\r`);

        // Only the thread's own running tasks resolve.
        const openedBefore = opened.length;
        const otherThread = yield* Effect.exit(follow("thread-a", "bmon1"));
        const notRunning = yield* Effect.exit(follow("thread-m", "bmon9"));
        assert.match(messageOf(otherThread), /no running background task with that id/);
        assert.match(messageOf(notRunning), /no running background task with that id/);
        assert.lengthOf(opened, openedBefore);
      }).pipe(Effect.provide(layer)),
  );

  effectIt.effect("also follows the existing log files a waiting shell's command watches", () =>
    Effect.gen(function* () {
      const runLog = NodePath.join(dir, "tmp", "run.log");
      const monitoredLog = NodePath.join(dir, "fit.log");
      NodeFS.mkdirSync(NodePath.dirname(runLog), { recursive: true });
      NodeFS.writeFileSync(runLog, "step 1\n");
      NodeFS.writeFileSync(monitoredLog, "fit 1\n");
      const waitFile = NodePath.join(dir, "tasks", "bwait1.output");
      NodeFS.writeFileSync(waitFile, "");
      // A subagent's Bash call backgrounds a silent wait on a relative log beside a missing one.
      yield* insertItem(
        "item-wait",
        "thread-w",
        `{"type":"command_execution","input":"until grep -q DONE tmp/run.log missing.log; do sleep 20; done","output":"${notice("bwait1", waitFile)}"}`,
      );
      yield* follow("thread-w", "bwait1");
      assert.equal(opened.at(-1)?.env?.T3CODE_WATCHED_LOG_1, runLog);
      assert.isUndefined(opened.at(-1)?.env?.T3CODE_WATCHED_LOG_2);
      assert.equal(
        written.at(-1),
        ` tail -c 204800 -F "$T3CODE_BACKGROUND_OUTPUT" "$T3CODE_WATCHED_LOG_1"\r`,
      );

      // A Monitor's result names only its task id. With its own output file gone, only the log
      // it watches is followed.
      yield* insertItem(
        "item-monitor",
        "thread-m",
        `{"type":"dynamic_tool","input":{"command":"tail -n0 -F ${monitoredLog} | grep --line-buffered Traceback"},"output":{"taskId":"bmon1"}}`,
      );
      sessionTasksDir = NodePath.join(dir, "tasks");
      NodeFS.rmSync(NodePath.join(sessionTasksDir, "bmon1.output"), { force: true });
      yield* follow("thread-m", "bmon1");
      assert.equal(opened.at(-1)?.env?.T3CODE_WATCHED_LOG_1, monitoredLog);
      assert.equal(written.at(-1), ` tail -c 204800 -F "$T3CODE_WATCHED_LOG_1"\r`);
    }).pipe(Effect.provide(layer)),
  );
});
