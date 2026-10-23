import {
  DEFAULT_CODEX_SETTINGS,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
} from "./CodexAdapterV2.testHarness.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import * as CodexClient from "effect-codex-app-server/client";

import * as CodexReplay from "effect-codex-app-server/replay";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

describe("CodexAdapterV2 file change approvals", () => {
  it("keeps the reason, grant root, all file operations, and renamed paths", () => {
    const fileChanges = {
      "/tmp/removed.md": { type: "delete" as const, content: "gone" },
      "/tmp/added.ts": { type: "add" as const, content: "export {};" },
      "/tmp/moved.ts": {
        type: "update" as const,
        unified_diff: "@@",
        move_path: "/tmp/renamed.ts",
      },
    };
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: "  Update configuration. ",
        grantRoot: "/workspace",
        fileChanges,
      }),
      "Update configuration.\n\nGrant root: /workspace\nadd /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", fileChanges }),
      "add /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
  });

  it("falls back to a nonblank grant root and omits empty details", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", grantRoot: " /workspace " }),
      "Grant root: /workspace",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges: {}, grantRoot: "/workspace" }),
      "Grant root: /workspace",
    );
    assert.isUndefined(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: " ",
        grantRoot: " ",
        fileChanges: {},
      }),
    );
  });

  it("keeps every file path in a large patch description", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `/tmp/file-${String(index).padStart(2, "0")}.ts`,
        { type: "add" as const, content: "" },
      ]),
    );
    const detail = CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges });
    assert.equal(detail?.split("\n").length, 25);
    assert.isTrue(detail?.startsWith("add /tmp/file-00.ts") ?? false);
    assert.isTrue(detail?.endsWith("add /tmp/file-24.ts") ?? false);
  });

  it("uses item-start file changes when Codex omits the approval payload", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        itemChanges: [
          { path: "/tmp/z.ts", kind: { type: "delete" } },
          { path: "/tmp/a.ts", kind: { type: "add" } },
        ],
      }),
      "add /tmp/a.ts\ndelete /tmp/z.ts",
    );
  });
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

describe("CodexAdapterV2 post-settle continuation", () => {
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
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "subagent.updated" }
          > => event.type === "subagent.updated",
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
      };
    });

  it.effect("adds the session MCP server without replacing launch-argument servers", () =>
    Effect.gen(function* () {
      const scenario = "launch-mcp-servers";
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-codex-mcp"),
        threadId: ThreadId.make(`thread-${scenario}`),
        providerSessionId: `provider-session-${scenario}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-codex-token",
        browserToolsAvailable: true,
      });
      const requests: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario,
          entries: codexReplayPreamble({
            nativeThreadId: "launch-mcp-thread",
            nativeTurnId: "unused",
            prompt: "unused",
          }).slice(0, 5),
        }),
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/start") requests.push(params);
          }),
      );
      assert.deepEqual(requests, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            "tools.update_plan.enabled": true,
            "features.default_mode_request_user_input": true,
            mcp_optional_startup_grace_ms: 10_000,
            "mcp_servers.t3-code": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
            },
          },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("disables native subagents for repository-managed Codex sessions", () =>
    Effect.gen(function* () {
      const scenario = "managed-native-subagents";
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-managed-codex"),
        threadId: ThreadId.make(`thread-${scenario}`),
        providerSessionId: `provider-session-${scenario}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
        managedIssue: true,
      });
      const requests: Array<unknown> = [];
      const entries = codexReplayPreamble({
        nativeThreadId: "managed-codex-thread",
        nativeTurnId: "unused",
        prompt: "unused",
      }).slice(0, 5);
      entries[3] = {
        type: "expect_outbound",
        label: "thread/start",
        frame: {
          id: 2,
          method: "thread/start",
          params: {
            config: {
              ...CodexAdapterV2.CODEX_THREAD_CONFIG,
              "features.multi_agent": false,
              "features.multi_agent_v2": false,
            },
          },
        },
      };
      yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario,
          entries,
        }),
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/start") requests.push(params);
          }),
      );
      assert.deepEqual(requests, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            "tools.update_plan.enabled": true,
            "features.default_mode_request_user_input": true,
            mcp_optional_startup_grace_ms: 10_000,
            "features.multi_agent": false,
            "features.multi_agent_v2": false,
            "mcp_servers.t3-code": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer test-token" },
            },
          },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.role === "assistant",
    );
  const assistantTurnItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem]
        : [],
    );

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
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
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
          },
        ),
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

  const backgroundStopCases = [true, false, "still_running", "thread_unloaded"] as const;
  const makeBackgroundStopTranscript = (terminated: (typeof backgroundStopCases)[number]) => {
    const stillRunning = terminated === "still_running";
    return makeCodexReplayTranscript({
      scenario: `codex-bg-stop-${terminated}`,
      entries: [
        ...backgroundExecTranscript.entries.slice(0, -1),
        {
          type: "expect_outbound",
          label: "terminate-background-command",
          frame: {
            id: 4,
            method: "thread/backgroundTerminals/terminate",
            params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
          },
        },
        {
          type: "emit_inbound",
          label: "terminate-background-command",
          frame:
            terminated === "thread_unloaded"
              ? {
                  id: 4,
                  error: { code: -32600, message: `thread not found: ${BG_NATIVE_THREAD}` },
                }
              : { id: 4, result: { terminated: terminated === true } },
        },
        ...(terminated === false || stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 5,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: {
                  id: 5,
                  result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
                },
              },
            ]
          : []),
        ...(stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 6,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 6, result: { terminated: false } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 7,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 8,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 8, result: { terminated: true } },
              },
            ]
          : []),
        backgroundExecTranscript.entries.at(-1)!,
      ],
    });
  };

  const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";
  const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";
  const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

  const preSettleTranscript = makeCodexReplayTranscript({
    scenario: PRE_SETTLE_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
        nativeTurnId: PRE_SETTLE_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-pre-settle",
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441000,
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
              id: "root-answer-pre-settle",
              text: "DONE",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
          },
        },
      },
    ],
  });

  const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";
  const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";
  const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";
  const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";
  const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";
  const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";
  const INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-child-timeout-boundary";
  const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";
  const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";
  const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";
  const INTERRUPT_LATE_CHILD_2_NATIVE_TURN = "native-codex-interrupt-late-child-2-turn";
  const INTERRUPT_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-timeout-boundary";
  const INTERRUPT_TIMEOUT_LATE_ITEM = "exec-codex-interrupt-timeout-late";
  const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";
  const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";
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

  const interruptMidCommandTranscript = makeCodexReplayTranscript({
    scenario: INTERRUPT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
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
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: { id: 6, result: { data: [], nextCursor: null } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 7,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 7, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
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

  const assertChildProviderTerminalBeforeRoot = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    rootThreadId: ThreadId,
  ) => {
    const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
    const childProviderTurnIndex = events.findIndex(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.threadId !== rootThreadId &&
        event.providerTurn.status === "interrupted",
    );
    const childProviderThreadIndex = events.findIndex(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.appThreadId !== rootThreadId &&
        event.providerThread.status === "idle",
    );
    assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
    assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
    assert.isAbove(
      terminalIndex,
      childProviderTurnIndex,
      "child provider turn must terminalize before the root run",
    );
    assert.isAbove(
      terminalIndex,
      childProviderThreadIndex,
      "child provider thread must become idle before the root run",
    );
  };

  const childInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/child",
  );
  const rootInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/root",
  );
  const interruptSubagentRequestFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-request-failure",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootInterruptResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-before-child-interrupt-failure",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(
        rootInterruptResponseIndex + 1,
        childInterruptResponseIndex,
      ),
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          error: { code: -32_000, message: "child interrupt request failed" },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const childTurnStartedIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/started/child",
  );
  const failedRootLiveChildTranscript = makeCodexReplayTranscript({
    scenario: "codex-failed-root-live-subagent",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTurnStartedIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-failed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "failed" }),
              error: {
                message: "unsupported websocket request type: response.interrupt",
                codexErrorInfo: "other",
                additionalDetails: null,
              },
            },
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/child",
        afterMs: 30_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_CHILD_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const childTerminationResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "thread/backgroundTerminals/terminate/child",
  );
  const interruptSubagentTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-timeout",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "item/started/child-timeout-boundary",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM,
              processId: null,
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441600,
          },
        },
      },
    ],
  });

  const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
  );
  const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
      {
        type: "emit_inbound",
        label: "turn/started/late-child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child",
        frame: { id: 7, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const interruptRescanLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-rescan-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/started/late-child-1",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-1",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/late-child-2",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-1",
        frame: { id: 7, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-2",
        frame: {
          id: 8,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-2",
        frame: { id: 8, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const interruptTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-timeout",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
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
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-at-timeout-boundary",
        afterMs: 9_999,
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
              command: "echo TIMEOUT_BOUNDARY",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo TIMEOUT_BOUNDARY" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622450500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/late",
        afterMs: 20_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-after-timeout",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_LATE_ITEM,
              command: "echo LATE_AFTER_TIMEOUT",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo LATE_AFTER_TIMEOUT" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622470500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-termination-failure",
    entries: [
      ...interruptMidCommandTranscript.entries
        .filter(
          (entry) => entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
        )
        .map((entry) =>
          entry.type === "emit_inbound" &&
          entry.label === "thread/backgroundTerminals/list/after-false"
            ? {
                ...entry,
                frame: {
                  id: 6,
                  result: {
                    data: [{ processId: "57680" }],
                    nextCursor: null,
                  },
                },
              }
            : entry,
        ),
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: {
          id: 8,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: { id: 8, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          result: { data: [{ processId: "57680" }], nextCursor: null },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const FAILED_SCENARIO = "codex-failed-mid-command";
  const FAILED_NATIVE_THREAD = "native-codex-failed-thread";
  const FAILED_NATIVE_TURN = "native-codex-failed-turn";
  const FAILED_COMMAND_ITEM = "exec-codex-failed-command";
  const FAILED_COMMAND = "sleep 30";
  const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

  const failedMidCommandTranscript = makeCodexReplayTranscript({
    scenario: FAILED_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: FAILED_NATIVE_THREAD,
        nativeTurnId: FAILED_NATIVE_TURN,
        prompt: FAILED_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: FAILED_COMMAND_ITEM,
              command: FAILED_COMMAND,
              cwd: "/workspace",
              processId: "99",
              source: "unifiedExecStartup",
              status: "inProgress",
              commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            threadId: FAILED_NATIVE_THREAD,
            turnId: FAILED_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: FAILED_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({
                id: FAILED_NATIVE_TURN,
                status: "failed",
              }),
              error: { message: "provider failed mid-command" },
            },
          },
        },
      },
    ],
  });

  const MCP_APP_SCENARIO = "codex-mcp-app-capture";
  const MCP_APP_NATIVE_THREAD = "native-codex-mcp-app-thread";
  const MCP_APP_NATIVE_TURN = "native-codex-mcp-app-turn";
  const MCP_APP_ITEM = "mcp-weather-call";
  const MCP_APP_PROMPT = "Show the weather in Oslo.";
  const MCP_APP_RESOURCE = "ui://weather/dashboard";
  const MCP_APP_HTML = "<!doctype html><html><body><p>Weather</p><script>1</script></body></html>";
  const mcpAppToolItem = (status: "inProgress" | "completed") => ({
    type: "mcpToolCall",
    id: MCP_APP_ITEM,
    server: "weather",
    tool: "get_weather",
    status,
    arguments: { city: "Oslo" },
    mcpAppResourceUri: MCP_APP_RESOURCE,
    ...(status === "completed"
      ? { result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temp: 21 } } }
      : {}),
  });

  const mcpAppTranscript = makeCodexReplayTranscript({
    scenario: MCP_APP_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/app-tool",
        frame: {
          method: "item/started",
          params: {
            item: mcpAppToolItem("inProgress"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          result: {
            contents: [
              {
                uri: MCP_APP_RESOURCE,
                mimeType: "text/html;profile=mcp-app",
                text: MCP_APP_HTML,
                _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
              },
            ],
          },
        },
      },
    ],
  });

  const failedMcpAppTranscript = makeCodexReplayTranscript({
    scenario: "codex-mcp-app-capture-failed-turn",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "failed" }),
              error: { message: "provider failed mid-capture" },
            },
          },
        },
      },
    ],
  });

  const ORPHAN_WAIT_SCENARIO = "codex-orphaned-dynamic-tool";
  const ORPHAN_WAIT_NATIVE_THREAD = "native-codex-orphan-wait-thread";
  const ORPHAN_WAIT_NATIVE_TURN = "native-codex-orphan-wait-turn";
  const ORPHAN_WAIT_ITEM = "exec-4669f3bb-78c9-4af1-b44e-daa340d2c538";
  const PERSISTENT_MONITOR_ITEM = "exec-persistent-monitor";
  const COMPLETED_WAIT_ITEM = "exec-completed-wait";
  const ORPHAN_WAIT_PROMPT = "Wait on two nested tasks, then finish.";

  const orphanedDynamicToolTranscript = makeCodexReplayTranscript({
    scenario: ORPHAN_WAIT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: ORPHAN_WAIT_NATIVE_THREAD,
        nativeTurnId: ORPHAN_WAIT_NATIVE_TURN,
        prompt: ORPHAN_WAIT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/completed-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "t3-code",
              tool: "t3_thread_wait",
              status: "inProgress",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/completed-wait",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "t3-code",
              tool: "t3_thread_wait",
              status: "completed",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
              result: { content: [{ type: "text", text: "idle" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/orphan-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: ORPHAN_WAIT_ITEM,
              server: "t3-code",
              tool: "t3_thread_wait",
              status: "inProgress",
              arguments: {
                threadId:
                  "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
                timeoutMs: 30000,
              },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622442500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/persistent-monitor",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "inProgress",
              arguments: { persistent: true, command: "tail -f" },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622443500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: ORPHAN_WAIT_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/persistent-monitor",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "completed",
              arguments: { persistent: true, command: "tail -f" },
              result: { content: [{ type: "text", text: "stopped" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622473500,
          },
        },
      },
    ],
  });

  const RESUME_SCENARIO = "codex-resume-subagent";
  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
    readonly omitPhase?: boolean;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: {
          ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
          startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
        },
      },
    },
  });

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
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
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect("gives a worker subagent's thread the Implementor role its child thread reports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const roleReported = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          resumeSubagentTranscript,
          (event) =>
            event.type === "app_thread.created" && event.appThread.role !== undefined
              ? Deferred.succeed(roleReported, undefined)
              : Effect.void,
          undefined,
          (threadId) =>
            Effect.succeed({ thread: { id: threadId, model: "gpt-6-sol", agentRole: "worker" } }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-child-role"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(roleReported);
        yield* TestClock.adjust("100 millis");
        yield* harness.firstTerminal;
        const childThreads = harness.events.flatMap((event) =>
          event.type === "app_thread.created" ? [event.appThread] : [],
        );
        assert.deepEqual(
          childThreads.map((thread) => thread.role),
          [undefined, "implementor"],
        );
        assert.equal(childThreads[1]?.id, childThreads[0]?.id);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
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
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });
});
