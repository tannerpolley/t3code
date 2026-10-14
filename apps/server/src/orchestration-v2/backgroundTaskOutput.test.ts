// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { shellCommandWords } from "@t3tools/shared/shellCommand";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, assert, describe, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import {
  aggregateBackgroundTaskProcessUsage,
  backgroundTaskOutputPath,
  BackgroundTasks,
  layer as backgroundTasksLayer,
  initialOutputTailState,
  readOutputTail,
} from "./backgroundTaskOutput.ts";
import { codexBackgroundTaskLogPath, makeBackgroundTaskLogWriter } from "./backgroundTaskFiles.ts";

const CLAUDE_BACKGROUND_COMMAND = "for i in $(seq 1 40); do echo tick $i; sleep 3; done";
const CLAUDE_BACKGROUND_ARGV = String.raw`/bin/bash -c source /home/tnnrpolley21/.t3/provider-homes/claude/shell-snapshots/snapshot-bash-….sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'for i in $(seq 1 40); do echo tick $i; sleep 3; done' < /dev/null && pwd -P >| /tmp/claude-6c53-cwd`;

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

  it("attributes the exact Claude background Bash argv captured in the sandbox", () => {
    assert.includeDeepMembers(shellCommandWords(CLAUDE_BACKGROUND_ARGV), [
      ["eval", CLAUDE_BACKGROUND_COMMAND],
    ]);
    assert.deepEqual(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree(CLAUDE_BACKGROUND_ARGV),
        serverPid: 1,
        command: CLAUDE_BACKGROUND_COMMAND,
      }),
      { cpuPercent: 18.5, residentBytes: 100 },
    );
  });

  it("attributes Claude's escaped eval command without counting sibling shells", () => {
    const command = `for i in $(seq 1 5); do echo "it's $i"; sleep 1; done`;
    // Claude single-quotes the operand and writes each ' as '"'"'.
    const escaped = `'for i in $(seq 1 5); do echo "it'"'"'s $i"; sleep 1; done'`;
    const wrapper = CLAUDE_BACKGROUND_ARGV.replace(`'${CLAUDE_BACKGROUND_COMMAND}'`, escaped);
    assert.isFalse(wrapper.includes(command));
    assert.deepEqual(
      aggregateBackgroundTaskProcessUsage({
        processes: taskTree(wrapper),
        serverPid: 1,
        command,
      }),
      { cpuPercent: 18.5, residentBytes: 100 },
    );
    assert.isNull(
      aggregateBackgroundTaskProcessUsage({
        processes: [...taskTree(wrapper), process(40, 10, 7, 80, wrapper)],
        serverPid: 1,
        command,
      }),
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

describe("BackgroundTasks", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-output-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const claudeFile = NodePath.join(dir, "tasks", "bclaude1.output");
  NodeFS.mkdirSync(NodePath.dirname(claudeFile));
  NodeFS.writeFileSync(claudeFile, "hello\n");

  // One live Claude session, whose roster holds thread-m's running monitor.
  let sessionTasksDir: string | null = null;
  const monitorThread = {
    id: ProviderThreadId.make("provider-thread-m"),
    providerSessionId: ProviderSessionId.make("provider-session-m"),
    pendingBackgroundTasks: [{ taskId: "bmon1", kind: "monitor" }],
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
    SqlitePersistence.layerMemory,
    ServerConfig.layerTest(dir, { prefix: "bg-task-output-config-" }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (threadId) =>
        Effect.succeed({
          thread: { lineage: { parentThreadId: null } },
          providerThreads: threadId === "thread-m" ? [monitorThread] : [],
          turnItems: [],
        } as never),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            driver: "claudeAgent",
            backgroundTaskOutputDir: () => Effect.sync(() => sessionTasksDir),
          } as never),
        ),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const layer = backgroundTasksLayer.pipe(Layer.provideMerge(dependencies));

  const insertItem = (id: string, threadId: string, payload: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, 1, 'command_execution', 'running', '', ${payload})
      `;
    });
  /** The first output a viewer of the task receives. */
  const firstOutput = (threadId: string, taskId: string) =>
    Effect.flatMap(BackgroundTasks, (tasks) => tasks.subscribeOutput({ threadId, taskId })).pipe(
      Effect.flatMap(Stream.runHead),
      Effect.map((chunk) => Option.getOrNull(chunk)?.text),
    );

  effectIt.effect(
    "samples Claude roster and turn-item commands through the real thread shell",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const tasks = yield* BackgroundTasks;
        const now = yield* DateTime.now;
        const providerInstanceId = ProviderInstanceId.make("claudeAgent");
        const driver = ProviderDriverKind.make("claudeAgent");
        const modelSelection = { instanceId: providerInstanceId, model: "claude-sonnet" };
        for (const source of ["roster", "turn-item"] as const) {
          const threadId = ThreadId.make(`thread-usage-${source}`);
          const providerThreadId = ProviderThreadId.make(`provider-thread-usage-${source}`);
          const runId = RunId.make(`run-usage-${source}`);
          const taskId = `task-usage-${source}`;
          const common = { threadId, occurredAt: now };
          yield* store.apply({
            ...common,
            id: EventId.make(`usage-${source}-thread`),
            type: "thread.created",
            payload: {
              id: threadId,
              projectId: ProjectId.make("project-usage"),
              title: "Claude background shell",
              providerInstanceId,
              modelSelection,
              createdBy: "user",
              creationSource: "web",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThreadId,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          yield* store.apply({
            ...common,
            id: EventId.make(`usage-${source}-run`),
            type: "run.created",
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId,
              userMessageId: MessageId.make(`message-usage-${source}`),
              rootNodeId: NodeId.make(`node-usage-${source}`),
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
          yield* store.apply({
            ...common,
            id: EventId.make(`usage-${source}-provider-thread`),
            type: "provider-thread.updated",
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              pendingBackgroundTasks:
                source === "roster"
                  ? [
                      {
                        taskId,
                        kind: "command",
                        commandKind: "shell",
                        command: CLAUDE_BACKGROUND_COMMAND,
                      },
                    ]
                  : [],
            },
          });
          if (source === "turn-item") {
            // No native task link or launch result: attribution must use the shell's command.
            yield* store.apply({
              ...common,
              id: EventId.make(`usage-${source}-item`),
              type: "turn-item.updated",
              payload: {
                id: TurnItemId.make(taskId),
                threadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                type: "command_execution",
                status: "running",
                title: "Print 40 ticks, 3 seconds apart",
                input: `  ${CLAUDE_BACKGROUND_COMMAND}  `,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              },
            });
          }
          const usage = yield* tasks.resourceUsage({ threadIds: [threadId] });
          assert.deepEqual(
            usage,
            [{ threadId, taskId, cpuPercent: 1.5, residentBytes: 200 }],
            source,
          );
          assert.equal(
            (yield* store.getThreadShell(threadId))?.pendingBackgroundTasks?.[0]?.command,
            CLAUDE_BACKGROUND_COMMAND,
            source,
          );
        }
      }).pipe(
        Effect.provide(
          backgroundTasksLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.unwrap(
                  Effect.map(ProjectionStore.ProjectionStoreV2, (store) =>
                    Layer.mock(ThreadManagement.ThreadManagementService)({
                      getThreadRecords: (threadId, fields, filter) =>
                        store.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
                    }),
                  ),
                ),
                Layer.mock(ResourceTelemetry.ResourceTelemetry)({
                  refresh: Effect.succeed({
                    health: { native: { status: "healthy" } },
                    processes: [
                      {
                        identity: { pid: 20, startTimeMs: 1 },
                        ppid: 10,
                        command: CLAUDE_BACKGROUND_ARGV,
                        cpuPercent: 1,
                        residentBytes: 100,
                      },
                      {
                        identity: { pid: 21, startTimeMs: 1 },
                        ppid: 20,
                        command: "sleep 3",
                        cpuPercent: 0.5,
                        residentBytes: 100,
                      },
                    ],
                  } as never),
                }),
              ).pipe(
                Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provideMerge(dependencies))),
              ),
            ),
          ),
        ),
      ),
  );

  effectIt.effect("shares one process sample across callers within the poll interval", () => {
    let samples = 0;
    const telemetry = Layer.mock(ResourceTelemetry.ResourceTelemetry)({
      refresh: Effect.sync(() => {
        samples += 1;
        return { health: { native: { status: "healthy" } }, processes: [] } as never;
      }).pipe(Effect.delay("200 millis")),
    });
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: { lineage: { parentThreadId: null }, activeProviderThreadId: null },
          providerThreads: [
            {
              id: "provider-thread",
              pendingBackgroundTasks: [{ taskId: "t1", kind: "command", command: "make" }],
            },
          ],
          turnItems: [],
        } as never),
    });
    return Effect.gen(function* () {
      const tasks = yield* BackgroundTasks;
      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");
      const poll = Effect.all(
        [
          tasks.processes({ threadId: threadA }),
          tasks.processes({ threadId: threadB }),
          tasks.resourceUsage({ threadIds: [threadA, threadB] }),
        ],
        { concurrency: "unbounded" },
      );
      const first = yield* Effect.forkChild(poll);
      yield* TestClock.adjust("200 millis");
      yield* Fiber.join(first);
      assert.equal(samples, 1);
      yield* TestClock.adjust("3 seconds");
      yield* tasks.processes({ threadId: threadA });
      assert.equal(samples, 1);
      yield* TestClock.adjust("2 seconds");
      const next = yield* Effect.forkChild(tasks.processes({ threadId: threadA }));
      yield* TestClock.adjust("200 millis");
      yield* Fiber.join(next);
      assert.equal(samples, 2);
    }).pipe(
      Effect.provide(
        backgroundTasksLayer.pipe(
          Layer.provideMerge(Layer.mergeAll(dependencies, telemetry, threads)),
        ),
      ),
    );
  });

  effectIt.effect(
    "reads a Claude task's file or a Codex task's log, and only the thread's own tasks",
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
        const codexLog = codexBackgroundTaskLogPath(logsDir, "thread-a", "call_codex1");
        NodeFS.mkdirSync(NodePath.dirname(codexLog), { recursive: true });
        NodeFS.writeFileSync(codexLog, "codex output\n");

        assert.equal(yield* firstOutput("thread-a", "bclaude1"), "hello\n");
        assert.equal(yield* firstOutput("thread-a", "call_codex1"), "codex output\n");
        assert.equal((yield* Effect.exit(firstOutput("thread-b", "bclaude1")))._tag, "Failure");
        assert.equal((yield* Effect.exit(firstOutput("thread-a", "nope")))._tag, "Failure");
      }).pipe(Effect.provide(layer)),
  );

  effectIt.effect(
    "reads a running Claude monitor in the directory its live session reported, and says what's missing",
    () =>
      Effect.gen(function* () {
        const messageOf = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
          Exit.isFailure(exit)
            ? (Option.getOrNull(Cause.findErrorOption(exit.cause))?.message ?? "")
            : "";
        // A Monitor's tool result names no file, and until Claude reports a task path neither
        // does anything else in its session.
        const unreported = yield* Effect.exit(firstOutput("thread-m", "bmon1"));
        assert.match(messageOf(unreported), /has not reported where this session keeps/);

        // Claude writes each monitor event, as it happens, to <session>/tasks/<taskId>.output.
        sessionTasksDir = NodePath.join(dir, "tasks");
        NodeFS.writeFileSync(NodePath.join(sessionTasksDir, "bmon1.output"), "event 1\nevent 2\n");
        assert.equal(yield* firstOutput("thread-m", "bmon1"), "event 1\nevent 2\n");

        // Only the thread's own running tasks resolve.
        const otherThread = yield* Effect.exit(firstOutput("thread-a", "bmon1"));
        const notRunning = yield* Effect.exit(firstOutput("thread-m", "bmon9"));
        assert.match(messageOf(otherThread), /no running background task with that id/);
        assert.match(messageOf(notRunning), /no running background task with that id/);
      }).pipe(Effect.provide(layer)),
  );
});
