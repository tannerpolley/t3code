import {
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import packageJson from "../../../package.json" with { type: "json" };
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;

const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
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

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

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

const makeCodexReplayHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
    Effect.void,
  onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
  readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplay(transcript)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) =>
                withCodexReplayChildMetadata(client, transcript, readChildMetadata),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const firstTerminal = yield* Deferred.make<void>();
    const eventStreamEnded = yield* Deferred.make<Exit.Exit<void, unknown>>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTerminal, undefined)
              : Effect.void,
          ),
          Effect.andThen(onEvent(event)),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.succeed(eventStreamEnded, exit)),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const subagentUpdates = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
          event.type === "subagent.updated",
      );
    return {
      runtime,
      providerThread,
      threadId,
      serverConfig,
      events,
      continuationRequests,
      terminalEvents,
      subagentUpdates,
      hasPendingBackgroundWork,
      firstTerminal: Deferred.await(firstTerminal),
      eventStreamExit: Deferred.await(eventStreamEnded),
    };
  });

const finalAnswerTranscript = (
  scenario: string,
  answers: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly phase?: "commentary" | "final_answer" | null;
    readonly omitPhase?: boolean;
    readonly streamed?: boolean;
    readonly completionDelayMs?: number;
  }>,
) => {
  const nativeThreadId = `native-${scenario}-thread`;
  const nativeTurnId = `native-${scenario}-turn`;
  const prompt = "Reply with the requested recovery marker.";
  return makeCodexReplayTranscript({
    scenario,
    entries: [
      ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
      ...answers.flatMap((answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
        const phase = answer.omitPhase
          ? {}
          : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
        const completed: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: `item/completed/${answer.id}`,
          ...(answer.completionDelayMs === undefined ? {} : { afterMs: answer.completionDelayMs }),
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                id: answer.id,
                text: answer.text,
                ...phase,
                memoryCitation: null,
              },
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              completedAtMs: 1782622441000 + index,
            },
          },
        };
        if (!answer.streamed) {
          return [completed];
        }
        return [
          {
            type: "emit_inbound",
            label: `item/started/${answer.id}`,
            frame: {
              method: "item/started",
              params: {
                item: {
                  type: "agentMessage",
                  id: answer.id,
                  text: "",
                  ...phase,
                  memoryCitation: null,
                },
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                startedAtMs: 1782622440500 + index,
              },
            },
          },
          {
            type: "emit_inbound",
            label: `item/agentMessage/delta/${answer.id}`,
            frame: {
              method: "item/agentMessage/delta",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId: answer.id,
                delta: answer.text,
              },
            },
          },
          completed,
        ];
      }),
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
          },
        },
      },
    ],
  });
};

const BG_SCENARIO = "codex-bg-exec-wake";

const BG_NATIVE_THREAD = "native-codex-bg-thread";

const BG_NATIVE_TURN = "native-codex-bg-turn";

const BG_COMMAND_ITEM = "call-codex-bg-command";

const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";

const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: BG_COMMAND_ITEM,
  command: BG_COMMAND,
  cwd: "/workspace",
  processId: "4242",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: BG_COMMAND }],
  aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 25_000 : null,
});

const backgroundExecTranscript = makeCodexReplayTranscript({
  scenario: BG_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: BG_NATIVE_THREAD,
      nativeTurnId: BG_NATIVE_TURN,
      prompt: BG_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: backgroundCommandItem("inProgress"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-bg",
            text: "STARTED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: BG_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: backgroundCommandItem("completed"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";

const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";

const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";

const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";

const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";

const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";

const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";

const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: INTERRUPT_COMMAND_ITEM,
  command: INTERRUPT_COMMAND,
  cwd: "/workspace",
  processId: "57680",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
  aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 30_000 : null,
});

const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-subagent-command",
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: INTERRUPT_NATIVE_THREAD,
      nativeTurnId: INTERRUPT_NATIVE_TURN,
      prompt: INTERRUPT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-interrupt-subagent",
            kind: "started",
            agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
            agentPath: "/root/stop_hold",
          },
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started/child",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/child-command",
      frame: {
        method: "item/started",
        params: {
          item: {
            ...interruptCommandItem("inProgress"),
            id: INTERRUPT_CHILD_COMMAND_ITEM,
            processId: "57682",
          },
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
          startedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/root",
      frame: {
        id: 4,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/root",
      frame: { id: 4, result: {} },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/child",
      frame: {
        id: 5,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/child",
      frame: { id: 5, result: {} },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: {
        id: 6,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: { id: 6, result: { terminated: true } },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/child-completed-race",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "completed",
          }),
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

const RESUME_NATIVE_THREAD = "native-codex-resume-thread";

const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";

const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

// One transcript per case: each child spawns during the root turn and ends
// either before or after the root turn settles. Codex reports a child's end
// twice (its own turn/completed, then a parent-side activity item), and a
// final child turn/started is the receipt that every earlier frame landed.
const subagentWakeTranscript = (
  scenario: string,
  children: ReadonlyArray<{ readonly name: string; readonly endsInTurn: boolean }>,
) => {
  const childThread = (name: string) => `native-wake-child-${name}`;
  const childTurn = (name: string, ordinal = 1) => `native-wake-child-${name}-turn-${ordinal}`;
  const childEnds = (name: string): Array<CodexReplay.CodexAppServerReplayEntry> => [
    {
      type: "emit_inbound",
      label: `answer/${name}`,
      frame: {
        method: "item/completed",
        params: {
          threadId: childThread(name),
          turnId: childTurn(name),
          item: {
            type: "agentMessage",
            id: `answer-${name}`,
            text: `${name.toUpperCase()}_DONE`,
            phase: "final_answer",
            memoryCitation: null,
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: `turn/completed/${name}`,
      frame: {
        method: "turn/completed",
        params: {
          threadId: childThread(name),
          turn: makeCodexReplayTurn({ id: childTurn(name), status: "completed" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: `activity-completed/${name}`,
      frame: {
        method: "item/completed",
        params: {
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          item: {
            type: "subAgentActivity",
            id: `activity-completed-${name}`,
            kind: "completed",
            agentThreadId: childThread(name),
            agentPath: `/root/${name}`,
          },
        },
      },
    },
  ];
  const childTurnStart = (name: string, ordinal = 1): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${name}/${ordinal}`,
    frame: {
      method: "turn/started",
      params: {
        threadId: childThread(name),
        turn: makeCodexReplayTurn({ id: childTurn(name, ordinal), status: "inProgress" }),
      },
    },
  });
  const first = children[0]!.name;
  return {
    markerTurn: childTurn(first, 2),
    transcript: makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: RESUME_NATIVE_TURN,
          prompt: RESUME_PROMPT,
        }),
        ...children.flatMap(({ name }): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            label: `activity-started/${name}`,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "subAgentActivity",
                  id: `activity-started-${name}`,
                  kind: "started",
                  agentThreadId: childThread(name),
                  agentPath: `/root/${name}`,
                },
              },
            },
          },
          childTurnStart(name),
        ]),
        ...children.filter((child) => child.endsInTurn).flatMap(({ name }) => childEnds(name)),
        {
          type: "emit_inbound",
          label: "turn/completed/root",
          frame: {
            method: "turn/completed",
            params: {
              threadId: RESUME_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
            },
          },
        },
        ...children.filter((child) => !child.endsInTurn).flatMap(({ name }) => childEnds(name)),
        childTurnStart(first, 2),
      ],
    }),
  };
};

const runSubagentWakeCase = (
  scenario: string,
  children: ReadonlyArray<{ readonly name: string; readonly endsInTurn: boolean }>,
) =>
  Effect.gen(function* () {
    const { transcript, markerTurn } = subagentWakeTranscript(scenario, children);
    const received = yield* Deferred.make<void>();
    const harness = yield* makeCodexReplayHarness(transcript, (event) =>
      event.type === "provider_turn.updated" &&
      event.providerTurn.nativeTurnRef?.nativeId === markerTurn
        ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(scenario),
        text: RESUME_PROMPT,
      }),
    );
    yield* Deferred.await(received);
    assert.equal(harness.terminalEvents()[0]?.status, "completed");
    return harness;
  });
export {
  awaitUntil,
  backgroundCommandItem,
  backgroundExecTranscript,
  BG_COMMAND,
  BG_COMMAND_ITEM,
  BG_NATIVE_THREAD,
  BG_NATIVE_TURN,
  BG_PROMPT,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  codexReplayPreamble,
  DEFAULT_CODEX_SETTINGS,
  finalAnswerTranscript,
  INTERRUPT_CHILD_COMMAND_ITEM,
  INTERRUPT_CHILD_NATIVE_THREAD,
  INTERRUPT_CHILD_NATIVE_TURN,
  INTERRUPT_COMMAND,
  INTERRUPT_NATIVE_THREAD,
  INTERRUPT_NATIVE_TURN,
  INTERRUPT_PROMPT,
  interruptCommandItem,
  interruptSubagentCommandTranscript,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
  RESUME_NATIVE_THREAD,
  RESUME_NATIVE_TURN,
  RESUME_PROMPT,
  runSubagentWakeCase,
};
