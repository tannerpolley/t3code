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
  ProviderInstanceId,
  ProviderSessionId,
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

  it.effect.each([
    ["worker", { "features.multi_agent": false, "features.multi_agent_v2": false }],
    ["root", {}],
  ] as const)("sets native subagents for a %s Codex session", ([role, nativeSubagents]) =>
    Effect.gen(function* () {
      const scenario = `managed-native-subagents-${role}`;
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-managed-codex"),
        threadId: ThreadId.make(`thread-${scenario}`),
        providerSessionId: `provider-session-${scenario}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
        managedIssue: role,
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
              ...nativeSubagents,
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
            ...nativeSubagents,
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

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);
});
