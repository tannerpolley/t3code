// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../../provider/ClaudeModelCatalog.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;

const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

// A model only the fetched manifest knows, like a release newer than the app.
const MANIFEST_ONLY_CLAUDE_CATALOG = (() => {
  const opus5 = BUNDLED_CLAUDE_MODEL_CATALOG.models.find(
    (entry) => entry.model.slug === "claude-opus-5",
  )!;
  return {
    models: [
      ...BUNDLED_CLAUDE_MODEL_CATALOG.models,
      {
        ...opus5,
        model: { ...opus5.model, slug: "claude-opus-5-5-manifest-only", aliases: [] },
      },
    ],
  };
})();

const MANIFEST_ONLY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-opus-5-5-manifest-only",
} satisfies ModelSelection;

const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

// Background Bash ids and texts follow the claude_background_task_wake
// recording, so the frames below have the shapes the CLI really sends.
const WAKE_TASK_ID = "bdqirlcyw";

const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";

const WAKE_TASK_DESCRIPTION = "Background sleep test";

const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';

const WAKE_ASSISTANT_TEXT = "WAKE_DONE";

const WAKE_RESULT_TEXT = "WAKE_DONE";

function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

const wakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  description: WAKE_TASK_DESCRIPTION,
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000101",
  session_id: WAKE_NATIVE_SESSION,
});

const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const makeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly numTurns?: number;
  readonly origin?: { readonly kind: "task-notification" };
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly errors?: ReadonlyArray<string>;
  readonly apiErrorStatus?: number;
  // null omits the field, as the CLI does on a zero-turn result.
  readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
}) =>
  claudeSdkFrame({
    type: "result",
    subtype: input.subtype ?? "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: input.isError ?? false,
    num_turns: input.numTurns ?? 1,
    result: input.result,
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
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
    ...(input.terminalReason === null
      ? {}
      : { terminal_reason: input.terminalReason ?? "completed" }),
  });

const turnOneResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000102",
  result: "Kicked off the build in the background.",
});

const wakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  status: "completed",
  output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
  summary: WAKE_SUMMARY,
  uuid: "00000000-0000-4000-8000-000000000103",
  session_id: WAKE_NATIVE_SESSION,
});

const wakeAssistant = makeAssistantTextFrame({
  uuid: "00000000-0000-4000-8000-000000000107",
  text: WAKE_ASSISTANT_TEXT,
});

// The CLI opens the wake turn with `init`, seconds before its first output.
const wakeTurnInit = claudeSdkFrame({
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000110",
  session_id: WAKE_NATIVE_SESSION,
});

const wakeResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000104",
  result: WAKE_RESULT_TEXT,
  origin: { kind: "task-notification" },
});

const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${label}.`);
  });

const makeWakeHarnessWithOptions = (options?: {
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void>;
  readonly stopTask?: (
    taskId: string,
  ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly subagentLaunchToolUseId?: string;
  readonly nativeSessionId?: string;
  readonly settings?: ClaudeSettings;
  // A CLI process opened after the first streams from its own queue, so the
  // first one can exit (Queue.shutdown) and a later turn can start another.
  readonly freshQueueOnReopen?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const rosterReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
      >();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (
      message: SDKMessage,
      offered?: Deferred.Deferred<void>,
    ) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(sdkMessages, message);
      if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
      yield* Deferred.await(processed);
    });
    const offeredMessages: Array<SDKUserMessage> = [];
    const stoppedTaskIds: Array<string> = [];
    const permissionModeChanges: Array<string> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const continuationReceipts =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const requestReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      >();
    const terminalReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    const subagentReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
      >();
    const systemNoticeReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
      >();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(Effect.andThen(Queue.offer(continuationReceipts, request))),
      },
      queryRunner: {
        allocateSessionId: Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              const processMessages = yield* Queue.unbounded<SDKMessage>();
              processQueues.push(processMessages);
              return {
                messages: Stream.fromQueue(processMessages),
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
            return {
              messages: Stream.fromQueue(sdkMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    // The next pull happens after runForEach finishes handling this frame.
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const processed = processedMessages.get(message);
                          return processed === undefined
                            ? Effect.void
                            : Deferred.succeed(processed, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              ),
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }),
              setModel: () => Effect.void,
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                }),
              stopTask:
                options?.stopTask ??
                ((taskId) => Effect.sync(() => void stoppedTaskIds.push(taskId))),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            event.type === "provider_thread.updated" &&
            (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0
          )
            yield* Queue.offer(rosterReceipts, event);
          if (event.type === "runtime_request.updated") yield* Queue.offer(requestReceipts, event);
          if (event.type === "subagent.updated") {
            yield* Queue.offer(subagentReceipts, event);
          }
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
        }),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      processQueues,
      offerAndWait,
      rosterReceipts,
      offeredMessages,
      // The uuid Claude echoes on the turn answering the nth offered prompt.
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      stoppedTaskIds,
      continuationRequests,
      continuationReceipts,
      events,
      terminalReceipts,
      requestReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
    };
  });

const makeWakeHarness = makeWakeHarnessWithOptions();

const providerThreadRosterEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<
      ProviderAdapter.ProviderAdapterV2Event,
      { type: "provider_thread.updated" }
    > => event.type === "provider_thread.updated",
  );
export {
  awaitUntil,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  claudeSdkFrame,
  DEFAULT_CLAUDE_SETTINGS,
  makeAssistantTextFrame,
  makeClaudeTestTurnInput,
  makeResultFrame,
  makeWakeHarness,
  makeWakeHarnessWithOptions,
  MANIFEST_ONLY_CLAUDE_CATALOG,
  MANIFEST_ONLY_MODEL_SELECTION,
  providerThreadRosterEvents,
  turnOneResult,
  WAKE_ASSISTANT_TEXT,
  WAKE_NATIVE_SESSION,
  WAKE_RESULT_TEXT,
  WAKE_SUMMARY,
  WAKE_TASK_DESCRIPTION,
  WAKE_TASK_ID,
  wakeAssistant,
  wakeNotification,
  wakeResult,
  wakeTaskStarted,
  wakeTurnInit,
};
