import {
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  awaitUntil,
  makeWakeHarness,
  providerThreadRosterEvents,
} from "./ClaudeAdapterV2.testHarness.ts";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeAdapterV2.testHarness.ts";
// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("keeps a running Claude monitor typed after many newer monitors end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        let frameNumber = 0;
        const nextUuid = () => `00000000-0000-4000-8000-${String(++frameNumber).padStart(12, "0")}`;
        const monitorFrames = (index: number) => {
          const taskId = `monitor-task-${index}`;
          const toolUseId = `toolu_monitor_${index}`;
          const description = `Monitor ${index}`;
          return {
            taskId,
            start: [
              claudeSdkFrame({
                type: "assistant",
                message: {
                  model: "claude-sonnet-4-6",
                  id: `msg_monitor_${index}`,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: toolUseId,
                      name: "Monitor",
                      input: { description, command: "sleep 8 && echo MONITOR_DONE" },
                    },
                  ],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "system",
                subtype: "task_started",
                task_id: taskId,
                tool_use_id: toolUseId,
                description,
                is_backgrounded: true,
                task_type: "local_bash",
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUseId,
                      content: `Monitor started (task ${taskId}).`,
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
                tool_use_result: { taskId, persistent: false },
              }),
            ],
            end: claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: taskId,
              tool_use_id: toolUseId,
              status: "completed",
              output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
              summary: `Monitor "${description}" stream ended`,
              uuid: nextUuid(),
              session_id: WAKE_NATIVE_SESSION,
            }),
          };
        };

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-many-monitors"),
            text: "Watch the deploy, then re-arm short watches.",
            attachments: [],
          }),
        );
        const longRunning = monitorFrames(0);
        for (const frame of longRunning.start) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        for (let index = 1; index <= 65; index++) {
          const monitor = monitorFrames(index);
          for (const frame of monitor.start) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* Queue.offer(harness.sdkMessages, monitor.end);
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: longRunning.taskId,
                task_type: "local_bash",
                description: "Monitor 0",
              },
            ],
            uuid: nextUuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: nextUuid(), result: "Watching." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(roster, [
          {
            taskId: longRunning.taskId,
            kind: "monitor",
            description: "Monitor 0",
            commandKind: "watcher",
            command: "sleep 8 && echo MONITOR_DONE",
            startedAt: now,
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "clears the replaced sibling native thread roster when openQuery switches processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-sibling-replace-",
          });
          const nativeIds = ["native-thread-roster-a", "native-thread-roster-b"] as const;
          let allocateIndex = 0;
          // Real two-process model: each openQuery owns its own message queue.
          // A shared queue would mask sibling process death on replacement.
          const processQueues: Array<{
            readonly nativeThreadId: string;
            readonly queue: Queue.Queue<SDKMessage>;
          }> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.sync(() => {
                const next =
                  nativeIds[allocateIndex] ?? `native-thread-roster-extra-${allocateIndex}`;
                allocateIndex += 1;
                return next;
              }),
              open: (openInput) =>
                Effect.gen(function* () {
                  const nativeThreadId = openInput.options.sessionId ?? openInput.options.resume;
                  if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
                    return yield* Effect.die("openQuery must supply a native session id");
                  }
                  const queue = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push({ nativeThreadId, queue });
                  return {
                    messages: Stream.fromQueue(queue),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(queue),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const appThreadA = ThreadId.make("thread-claude-roster-a");
          const appThreadB = ThreadId.make("thread-claude-roster-b");
          const runtime = yield* adapter.openSession({
            threadId: appThreadA,
            providerSessionId: ProviderSessionId.make("provider-session-claude-sibling-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadA = yield* runtime.ensureThread({
            threadId: appThreadA,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadB = yield* runtime.ensureThread({
            threadId: appThreadB,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          assert.notEqual(
            providerThreadA.nativeThreadRef?.nativeId,
            providerThreadB.nativeThreadRef?.nativeId,
          );
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          if (runtime.hasPendingBackgroundWorkForThread === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWorkForThread.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const hasPendingBackgroundWorkForThread = runtime.hasPendingBackgroundWorkForThread;
          const now = yield* DateTime.now;
          const taskA = "task-roster-a";
          const taskB = "task-roster-b";

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadA,
              providerThread: providerThreadA,
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-a"),
              text: "Background work on A.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const processA = processQueues[0]!;
          yield* Queue.offer(
            processA.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskA,
              tool_use_id: "toolu-roster-a",
              description: "work on A",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000301",
              session_id: nativeIds[0],
            }),
          );
          yield* Queue.offer(
            processA.queue,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000302",
              result: "A settled with background work.",
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadA.id &&
                  event.status === "completed",
              ),
            "thread A terminal",
          );
          const rosterAAfterSettle = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadA.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterAAfterSettle ?? [], [
            { taskId: taskA, description: "work on A", kind: "command", startedAt: now },
          ]);
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadB,
              providerThread: { ...providerThreadB, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-b"),
              text: "Background work on B.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 2);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadA.id &&
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "sibling A roster cleared idle on process replacement",
          );
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          const processB = processQueues[1]!;
          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskB,
              tool_use_id: "toolu-roster-b",
              description: "work on B",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000303",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadB.id &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
              ),
            "thread B roster populated",
          );
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: true,
              num_turns: 1,
              result: "B failed",
              stop_reason: "end_turn",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              errors: ["B failed"],
              terminal_reason: "model_error",
              uuid: "00000000-0000-4000-8000-000000000304",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadB.id &&
                  event.status === "failed",
              ),
            "thread B failed terminal",
          );

          const rosterBAfterFail = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadB.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterBAfterFail ?? [], []);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );
});
