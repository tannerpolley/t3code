// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProviderSessionId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  awaitUntil,
  CLAUDE_TEST_RUNTIME_POLICY,
  claudeSdkFrame,
  DEFAULT_CLAUDE_SETTINGS,
  makeClaudeTestTurnInput,
  makeResultFrame,
  makeWakeHarness,
  MANIFEST_ONLY_CLAUDE_CATALOG,
  MANIFEST_ONLY_MODEL_SELECTION,
  providerThreadRosterEvents,
  turnOneResult,
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  wakeAssistant,
  wakeNotification,
  wakeResult,
  wakeTaskStarted,
  wakeTurnInit,
} from "./ClaudeAdapterV2.testHarness.ts";

describe("ClaudeAdapterV2 fetched model catalog", () => {
  it.effect("sizes and compiles manifest-only models from the fetched catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-catalog-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          modelCatalog: Effect.succeed(MANIFEST_ONLY_CLAUDE_CATALOG),
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-catalog"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  stopTask: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-catalog");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-catalog"),
          modelSelection: MANIFEST_ONLY_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        // The handoff budget is sized from this window; the bundled list said 200k.
        assert.equal(runtime.getModelContextWindow?.(MANIFEST_ONLY_MODEL_SELECTION), 1_000_000);

        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: MANIFEST_ONLY_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-catalog"),
            text: "hello",
            attachments: [],
            modelSelection: {
              ...MANIFEST_ONLY_MODEL_SELECTION,
              options: [{ id: "effort", value: "ultracode" }],
            },
          }),
        );
        assert.equal(openedOptions?.model, "claude-opus-5-5-manifest-only");
        assert.equal(openedOptions?.effort, "xhigh");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("learns where the session writes task output from what Claude reports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-task-output-dir"),
            text: "Watch the build.",
            attachments: [],
          }),
        );
        const outputDir = () =>
          harness.runtime.backgroundTaskOutputDir?.({ providerThread: harness.providerThread }) ??
          Effect.die("Claude must report its task output directory.");
        // Each roster change is a receipt that the frames before it were handled.
        const taskStarted = (taskId: string, uuidSuffix: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: `toolu-${taskId}`,
            description: taskId,
            task_type: "local_bash",
            uuid: `00000000-0000-4000-8000-00000000093${uuidSuffix}`,
            session_id: WAKE_NATIVE_SESSION,
          });

        // A Monitor's tool result names no file.
        yield* harness.offerAndWait(taskStarted("bmonitor1", "1"));
        assert.isNull(yield* outputDir());

        const tasksDir = `/tmp/claude-1000/-home-me-project/${WAKE_NATIVE_SESSION}/tasks`;
        for (const frame of [
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu-bshell1",
                  content: [
                    {
                      type: "text",
                      text: `Command running in background with ID: bshell1. Output is being written to: ${tasksDir}/bshell1.output. You will be notified when it completes.`,
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000932",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted("bshell1", "3"),
        ])
          yield* harness.offerAndWait(frame);
        assert.equal(yield* outputDir(), tasksDir);

        // A finished task's output_file reports it too, and a later report wins.
        const movedDir = `/tmp/claude-1000/-home-me-other/${WAKE_NATIVE_SESSION}/tasks`;
        for (const frame of [
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "bdone1",
            status: "completed",
            output_file: `${movedDir}/bdone1.output`,
            summary: "done",
            uuid: "00000000-0000-4000-8000-000000000934",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted("bshell2", "5"),
        ])
          yield* harness.offerAndWait(frame);
        assert.equal(yield* outputDir(), movedDir);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "keeps a background Bash command, tag and start across snapshots and stops it via the parent's query",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const AGENT_TOOL_USE_ID = "toolu-shell-owner-agent";
          const BASH_TOOL_USE_ID = "toolu-shell-owner-bash";
          const command = "for i in $(seq 1 40); do echo tick $i; sleep 3; done";
          const harness = yield* makeWakeHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-subagent-shell-owner"),
              text: "Have a subagent print 40 ticks in the background.",
              attachments: [],
            }),
          );
          const shellTask = {
            task_id: WAKE_TASK_ID,
            description: "Print 40 ticks, 3 seconds apart",
          };
          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "task-shell-owner-agent",
              tool_use_id: AGENT_TOOL_USE_ID,
              description: "Print 40 ticks",
              task_type: "local_agent",
              prompt: "Print 40 ticks.",
              uuid: "00000000-0000-4000-8000-000000000921",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: BASH_TOOL_USE_ID,
                    name: "Bash",
                    input: { command, run_in_background: true },
                  },
                ],
              },
              parent_tool_use_id: AGENT_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000922",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              ...shellTask,
              tool_use_id: BASH_TOOL_USE_ID,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000923",
              session_id: WAKE_NATIVE_SESSION,
            }),
          ])
            yield* harness.offerAndWait(frame);
          const rosters = () =>
            providerThreadRosterEvents(harness.events).flatMap((event) =>
              (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0
                ? [event.providerThread.pendingBackgroundTasks]
                : [],
            );
          const firstRoster = yield* Queue.take(harness.rosterReceipts);
          const startedAt = firstRoster.providerThread.pendingBackgroundTasks?.[0]?.startedAt;
          assert.isDefined(startedAt);
          assert.equal(firstRoster.providerThread.pendingBackgroundTasks?.[0]?.command, command);
          // A later snapshot must not restart the shell's clock.
          yield* TestClock.adjust("1 hour");
          // Snapshots carry ids only; the tag must survive the replacement.
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ ...shellTask, task_type: "local_bash" }],
              uuid: "00000000-0000-4000-8000-000000000924",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );

          yield* Queue.take(harness.rosterReceipts);
          const childThreadId =
            harness.events.find((event) => event.type === "subagent.updated")?.subagent
              .childThreadId ?? undefined;
          assert.isString(childThreadId);
          // The parent's session owns the shell, so it stays on the parent's roster.
          assert.deepEqual(rosters().at(-1), [
            {
              taskId: WAKE_TASK_ID,
              description: "Print 40 ticks, 3 seconds apart",
              kind: "command",
              commandKind: "shell",
              command,
              ownerThreadId: childThreadId,
              startedAt,
            },
          ]);

          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          // The shell runs in the parent's session, so the parent's query stops it.
          const stop = harness.runtime.stopBackgroundTask;
          if (stop === undefined) return yield* Effect.die("Claude must stop background tasks.");
          yield* stop({ providerThread: harness.providerThread, taskId: WAKE_TASK_ID });
          const unknown = yield* Effect.exit(
            stop({
              providerThread: harness.providerThread,
              taskId: "task-not-on-roster",
            }),
          );
          assert.isTrue(Exit.isFailure(unknown));
          assert.deepEqual(harness.stoppedTaskIds, [WAKE_TASK_ID]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("tags a Monitor watcher so it never pins the idle session as work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitorToolUseId = "toolu-monitor";
        const monitorTaskId = "task-monitor";
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-monitor"),
            text: "Watch the replay log.",
            attachments: [],
          }),
        );
        const monitorEntry = {
          task_id: monitorTaskId,
          task_type: "local_bash",
          description: "replay runner steps",
        };
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: monitorToolUseId,
                  name: "Monitor",
                  input: {
                    description: "replay runner steps",
                    command: "tail -n +1 -f /tmp/replay.log",
                    timeout_ms: 1_800_000,
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000951",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [monitorEntry],
            uuid: "00000000-0000-4000-8000-000000000952",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            ...monitorEntry,
            tool_use_id: monitorToolUseId,
            uuid: "00000000-0000-4000-8000-000000000953",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [monitorEntry],
            uuid: "00000000-0000-4000-8000-000000000954",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000955",
            result: "Watching the replay.",
          }),
        ]);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");
        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(
          roster?.map((task) => [task.taskId, task.kind]),
          [[monitorTaskId, "monitor"]],
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("tags a Monitor started before the wake run attaches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitorToolUseId = "toolu-idle-monitor";
        let nextUuid = 0;
        const frame = (fields: Record<string, unknown>) =>
          claudeSdkFrame({
            session_id: WAKE_NATIVE_SESSION,
            uuid: `uuid-${nextUuid++}`,
            ...fields,
          });
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-idle-monitor"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [wakeTaskStarted, turnOneResult]);
        yield* Queue.take(harness.terminalReceipts);
        const monitorEntry = { task_id: "task-idle-monitor", task_type: "local_bash" };
        yield* Queue.offerAll(harness.sdkMessages, [
          wakeNotification,
          frame({ type: "system", subtype: "init" }),
          frame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: monitorToolUseId,
                  name: "Monitor",
                  input: { command: "tail -f /tmp/dev.log", description: "dev server" },
                },
              ],
            },
          }),
          frame({ type: "system", subtype: "background_tasks_changed", tasks: [monitorEntry] }),
          frame({
            type: "system",
            subtype: "task_started",
            ...monitorEntry,
            tool_use_id: monitorToolUseId,
          }),
        ]);
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(harness.events)
              .at(-1)
              ?.providerThread.pendingBackgroundTasks?.some(
                (task) => task.taskId === "task-idle-monitor" && task.kind === "monitor",
              ) ?? false,
          "idle Monitor tagged as a monitor",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("settles a wake run whose turn Claude folded into a queued user run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const turnInput = (attempt: string, text: string, ordinal: number, wake = false) =>
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text,
            attachments: [],
            providerTurnOrdinal: ordinal,
            ...(wake ? { messageCreatedBy: "agent", messageCreationSource: "provider" } : {}),
          });

        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-fold-1", "Run the build in the background.", 1),
        );
        yield* Queue.offerAll(harness.sdkMessages, [wakeTaskStarted, turnOneResult]);
        yield* Queue.take(harness.terminalReceipts);

        // Claude starts its notification turn before the user's queued
        // follow-up attaches: the init is buffered and requests the wake run,
        // which queues behind the follow-up.
        yield* Queue.offerAll(harness.sdkMessages, [wakeNotification, wakeTurnInit]);
        yield* Queue.take(harness.continuationReceipts);
        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-fold-2", "How is the build going?", 2),
        );
        assert.lengthOf(harness.offeredMessages, 2);

        // Claude folds the follow-up into the running turn: one result ends
        // both, and it completes the user's run.
        yield* Queue.offerAll(harness.sdkMessages, [wakeAssistant, wakeResult]);
        yield* Queue.take(harness.terminalReceipts);

        // The wake run finds only the stale init; no result will follow.
        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-fold-3", "Background task completed.", 3, true),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("opens a fresh wake run for the turn after a zero-turn notification result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const turnInput = (attempt: string, text: string, ordinal: number, wake = false) =>
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text,
            attachments: [],
            providerTurnOrdinal: ordinal,
            ...(wake ? { messageCreatedBy: "agent", messageCreationSource: "provider" } : {}),
          });

        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-empty-wake-1", "Run the build in the background.", 1),
        );
        yield* Queue.offerAll(harness.sdkMessages, [wakeTaskStarted, turnOneResult]);
        yield* Queue.take(harness.terminalReceipts);

        yield* Queue.offerAll(harness.sdkMessages, [wakeNotification, wakeTurnInit]);
        yield* Queue.take(harness.continuationReceipts);
        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-empty-wake-2", "Background task completed.", 2, true),
        );
        assert.lengthOf(harness.terminalEvents(), 1);

        // The first turn ends without a model turn; Claude then opens the real one.
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000110",
            result: "",
            numTurns: 0,
            origin: { kind: "task-notification" },
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "init",
            uuid: "00000000-0000-4000-8000-000000000111",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.take(harness.continuationReceipts);
        yield* harness.runtime.startTurn(
          turnInput("attempt-claude-empty-wake-3", "Background task completed.", 3, true),
        );
        assert.lengthOf(harness.terminalEvents(), 2);

        yield* Queue.offerAll(harness.sdkMessages, [wakeAssistant, wakeResult]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("queues a steer behind an open question and cancels a question the CLI aborts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attemptId = RunAttemptId.make("attempt-claude-question-steer");
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Pick a target.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        const canUseTool = harness.getOpenedOptions()?.canUseTool;
        assert.isFunction(canUseTool);
        const abort = new AbortController();
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: "Where?",
                  options: [
                    { label: "Prod", description: "Production." },
                    { label: "Staging", description: "Staging." },
                  ],
                  multiSelect: false,
                },
              ],
            },
            { signal: abort.signal, toolUseID: "tool-steer-question", requestId: "request-steer" },
          ),
        ).pipe(Effect.forkScoped);
        yield* Queue.take(harness.requestReceipts);

        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          }),
          message: {
            createdBy: "agent",
            creationSource: "server",
            messageId: MessageId.make("message-question-steer"),
            text: "Delegated task finished.",
            attachments: [],
          },
        });
        assert.equal(harness.offeredMessages[1]?.priority, "next");

        abort.abort();
        assert.equal((yield* Fiber.join(questionResult))?.behavior, "deny");
        const cancelledRequest = yield* Queue.take(harness.requestReceipts);
        assert.equal(cancelledRequest.runtimeRequest.status, "cancelled");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("holds a wake turn's question until its continuation run attaches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-question-1"),
            text: "Check the build.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        // The CLI starts a wake turn on its own and asks before T3 has attached
        // the continuation run that should own the question.
        const questionInput = {
          questions: [
            {
              header: "Next",
              question: "Ship it?",
              options: [
                { label: "Yes", description: "Ship now." },
                { label: "No", description: "Wait." },
              ],
              multiSelect: false,
            },
          ],
        };
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-wake-question",
                  name: "AskUserQuestion",
                  input: questionInput,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000911",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
        const canUseTool = harness.getOpenedOptions()?.canUseTool;
        assert.isFunction(canUseTool);
        const questionResult = yield* Effect.promise(() =>
          canUseTool!("AskUserQuestion", questionInput, {
            signal: new AbortController().signal,
            toolUseID: "tool-wake-question",
            requestId: "request-wake-question",
          }),
        ).pipe(Effect.forkScoped);
        yield* Queue.take(harness.continuationReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-question-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        const request = yield* Queue.take(harness.requestReceipts);
        assert.lengthOf(
          harness.terminalEvents(),
          1,
          "continuation stays open while the question waits",
        );

        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          answers: { "Ship it?": ["Yes"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: { questions: questionInput.questions, answers: { "Ship it?": "Yes" } },
          toolUseID: "tool-wake-question",
        });

        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
