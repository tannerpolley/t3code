import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  awaitUntil,
  backgroundCommandItem,
  backgroundExecTranscript,
  BG_COMMAND_ITEM,
  BG_NATIVE_THREAD,
  BG_NATIVE_TURN,
  BG_PROMPT,
  codexReplayPreamble,
  finalAnswerTranscript,
  INTERRUPT_CHILD_COMMAND_ITEM,
  INTERRUPT_NATIVE_THREAD,
  INTERRUPT_PROMPT,
  interruptSubagentCommandTranscript,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
  runSubagentWakeCase,
} from "./CodexAdapterV2.testHarness.ts";

describe("CodexAdapterV2 native question mapping", () => {
  it("preserves other-answer support without inventing multi-selection", () => {
    const question = {
      id: "choice",
      header: "Choice",
      question: "Choose a branch",
      options: [{ label: "main", description: "Default branch" }],
    };
    const [choice, other, freeText] = CodexAdapterV2.codexUserInputQuestions([
      question,
      { ...question, isOther: true },
      { ...question, options: null, isOther: false },
    ]);
    assert.equal(choice?.allowCustomAnswer, false);
    assert.equal(other?.allowCustomAnswer, true);
    assert.equal(freeText?.allowCustomAnswer, true);
    assert.equal(choice?.multiSelect, false);
    assert.deepEqual(choice?.options, question.options);
  });
});
describe("CodexAdapterV2 runtime policy", () => {
  it.effect("sends the user's model roles in either interaction mode", () =>
    Effect.gen(function* () {
      const modelRoles = [
        {
          id: "checker",
          name: "Checker",
          description: "Read-only review",
          targets: [
            {
              providerInstanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
              unavailableReason: null,
            },
          ],
        },
      ] as const;
      for (const interactionMode of ["plan", "default"] as const) {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-roles-${interactionMode}`,
          codexInput: [{ type: "text", text: "delegate this" }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode, cwd: null },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          hasT3Mcp: true,
          modelRoles,
        });
        assert.include(
          params.additionalContext?.t3_code_model_roles?.value ?? "",
          '- Checker: Read-only review. gpt-5.4 (codex). Target JSON: `{"providerInstanceId":"codex","model":"gpt-5.4"}`',
        );
      }
    }),
  );
});
describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("keeps partial proposals non-actionable and supersedes the prior finished plan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "parity-plan-thread";
        const nativeTurnId = "parity-plan-turn";
        const item = (method: "item/started" | "item/completed", id: string, text: string) => ({
          type: "emit_inbound" as const,
          frame: {
            method,
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              startedAtMs: 1782622441000,
              completedAtMs: 1782622442000,
              item: { type: "plan", id, text },
            },
          },
        });
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "proposal-parity",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Make a plan." }),
              item("item/started", "first-plan", ""),
              {
                type: "emit_inbound",
                frame: {
                  method: "item/plan/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: "first-plan",
                    delta: "# First",
                  },
                },
              },
              item("item/completed", "first-plan", ""),
              item("item/completed", "second-plan", "# Revised"),
              item("item/started", "unfinished-plan", "# Incomplete"),
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
                  },
                },
              },
            ],
          }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("proposal-parity"),
            text: "Make a plan.",
          }),
        );
        yield* harness.firstTerminal;
        const plans = harness.events.flatMap((event) =>
          event.type === "plan.updated" ? [event.plan] : [],
        );
        assert.deepEqual(
          plans.map((plan) => plan.status),
          // The delta flushes with the completion, so it adds no draft of its own.
          ["draft", "active", "superseded", "active", "draft", "superseded"],
        );
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan"
            ? [event.turnItem]
            : [],
        );
        assert.equal(
          items.find((item) => item.markdown === "# First" && !item.streaming)?.status,
          "completed",
        );
        assert.equal(items.at(-1)?.streaming, false);
        assert.equal(items.at(-1)?.status, "interrupted");
        assert.equal(items.at(-1)?.markdown, "# Incomplete");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["failed", "interrupted"] as const)(
    "ends a plan that started without text when its turn is %s",
    (status) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = `empty-plan-thread-${status}`;
          const nativeTurnId = `empty-plan-turn-${status}`;
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({
              scenario: `empty-plan-${status}`,
              entries: [
                ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Make a plan." }),
                {
                  type: "emit_inbound",
                  frame: {
                    method: "item/started",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622441000,
                      item: { type: "plan", id: "empty-plan", text: "" },
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId, status }),
                    },
                  },
                },
              ],
            }),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`empty-plan-${status}`),
              text: "Make a plan.",
            }),
          );
          yield* harness.firstTerminal;
          const plans = harness.events.flatMap((event) =>
            event.type === "plan.updated" ? [event.plan] : [],
          );
          assert.deepEqual(
            plans.map((plan) => plan.status),
            ["draft", "superseded"],
          );
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan"
              ? [event.turnItem]
              : [],
          );
          assert.equal(items.at(-1)?.streaming, false);
          assert.equal(items.at(-1)?.status, "interrupted");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("includes the native command and reason in a command approval request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "command-approval-thread";
        const nativeTurnId = "command-approval-turn";
        const itemId = "command-approval-item";
        const reason = "Run the requested inspection.";
        const command = "git status --porcelain=v1";
        const requestRaised = yield* Deferred.make<void>();
        const transcript = makeCodexReplayTranscript({
          scenario: "command-approval-prompt",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Inspect status." }),
            {
              type: "emit_inbound",
              label: "command approval",
              frame: {
                id: 4,
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId,
                  approvalId: "command-approval-id",
                  startedAtMs: 1782622445000,
                  reason,
                  command,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "command approval response",
              frame: { id: 4, result: { decision: "accept" } },
            },
            {
              type: "emit_inbound",
              label: "turn completed",
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
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "runtime_request.updated"
            ? Deferred.succeed(requestRaised, undefined)
            : Effect.void,
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("command-approval-attempt"),
            text: "Inspect status.",
          }),
        );
        yield* Deferred.await(requestRaised);
        const requestEvent = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        assert.equal(requestEvent?.type, "runtime_request.updated");
        if (requestEvent?.type !== "runtime_request.updated") return;

        const approvalItem = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.requestId === requestEvent.runtimeRequest.id,
        );
        assert.equal(
          approvalItem?.type === "turn_item.updated" &&
            approvalItem.turnItem.type === "approval_request"
            ? approvalItem.turnItem.prompt
            : undefined,
          reason + "\n\n" + command,
        );
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "accept",
        });
        yield* harness.firstTerminal;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("uses started file changes in a V2 file-change approval request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "file-change-approval-thread";
        const nativeTurnId = "file-change-approval-turn";
        const itemId = "file-change-approval-item";
        const reason = "Update the requested files.";
        const requestRaised = yield* Deferred.make<void>();
        const transcript = makeCodexReplayTranscript({
          scenario: "file-change-approval-prompt",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Update files." }),
            {
              type: "emit_inbound",
              label: "file change started",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: {
                    type: "fileChange",
                    id: itemId,
                    status: "inProgress",
                    changes: [
                      {
                        path: "/workspace/removed.md",
                        kind: { type: "delete" },
                        diff: "--- a/workspace/removed.md",
                      },
                      {
                        path: "/workspace/old.ts",
                        kind: { type: "update", move_path: "/workspace/new.ts" },
                        diff: "--- a/workspace/old.ts",
                      },
                      {
                        path: "/workspace/added.ts",
                        kind: { type: "add" },
                        diff: "+++ b/workspace/added.ts",
                      },
                    ],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "file change approval",
              frame: {
                id: 4,
                method: "item/fileChange/requestApproval",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId,
                  startedAtMs: 1782622445000,
                  reason,
                  grantRoot: "/workspace",
                },
              },
            },
            {
              type: "expect_outbound",
              label: "file change approval response",
              frame: { id: 4, result: { decision: "accept" } },
            },
            {
              type: "emit_inbound",
              label: "turn completed",
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
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "runtime_request.updated"
            ? Deferred.succeed(requestRaised, undefined)
            : Effect.void,
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("file-change-approval-attempt"),
            text: "Update files.",
          }),
        );
        yield* Deferred.await(requestRaised);
        const requestEvent = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        assert.equal(requestEvent?.type, "runtime_request.updated");
        if (requestEvent?.type !== "runtime_request.updated") return;

        const approvalItem = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.requestId === requestEvent.runtimeRequest.id,
        );
        assert.equal(
          approvalItem?.type === "turn_item.updated" &&
            approvalItem.turnItem.type === "approval_request"
            ? approvalItem.turnItem.prompt
            : undefined,
          `${reason}\n\nGrant root: /workspace\nadd /workspace/added.ts\nupdate /workspace/old.ts -> /workspace/new.ts\ndelete /workspace/removed.md`,
        );
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "accept",
        });
        yield* harness.firstTerminal;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("shows the whole requested permission profile in a permissions approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "permissions-approval-thread";
        const nativeTurnId = "permissions-approval-turn";
        const reason = "Run the requested inspection.";
        const permissions = {
          fileSystem: {
            read: ["/repo/docs"],
            write: ["/tmp/approved-target"],
            entries: [{ access: "deny", path: { type: "glob_pattern", pattern: "/repo/**/.env" } }],
          },
          network: { enabled: true },
        };
        const requestRaised = yield* Deferred.make<void>();
        const transcript = makeCodexReplayTranscript({
          scenario: "permissions-approval-prompt",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Inspect." }),
            {
              type: "emit_inbound",
              label: "permissions approval",
              frame: {
                id: 4,
                method: "item/permissions/requestApproval",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId: "permissions-approval-item",
                  startedAtMs: 1782622445000,
                  cwd: "/repo",
                  reason,
                  permissions,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "permissions approval response",
              frame: { id: 4, result: { permissions, scope: "turn" } },
            },
            {
              type: "emit_inbound",
              label: "turn completed",
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
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "runtime_request.updated"
            ? Deferred.succeed(requestRaised, undefined)
            : Effect.void,
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("permissions-approval-attempt"),
            text: "Inspect.",
          }),
        );
        yield* Deferred.await(requestRaised);
        const requestEvent = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        if (requestEvent?.type !== "runtime_request.updated") return assert.fail("no request");
        const approvalItem = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.requestId === requestEvent.runtimeRequest.id,
        );
        assert.equal(
          approvalItem?.type === "turn_item.updated" &&
            approvalItem.turnItem.type === "approval_request"
            ? approvalItem.turnItem.prompt
            : undefined,
          `${reason}\n\nWorking directory: /repo\nread /repo/docs\nwrite /tmp/approved-target\ndeny /repo/**/.env\nnetwork enabled`,
        );
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "accept",
        });
        yield* harness.firstTerminal;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("stamps each agent message's phase on its turn item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-message-phases", [
          { id: "answer-commentary", text: "Working on it.", phase: "commentary" },
          { id: "answer-final", text: "Fixed." },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-message-phases"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            !event.turnItem.streaming
              ? [[event.turnItem.text, event.turnItem.phase]]
              : [],
          ),
          [
            ["Working on it.", "commentary"],
            ["Fixed.", "final_answer"],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("stops one background command by its item id through its process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const outputCaptured = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-bg-stop-one",
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
                frame: { id: 4, result: { terminated: true } },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: BG_NATIVE_THREAD,
                    turnId: BG_NATIVE_TURN,
                    item: {
                      ...backgroundCommandItem("completed"),
                      status: "failed",
                      exitCode: 130,
                    },
                  },
                },
              },
            ],
          }),
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? Deferred.succeed(event.turnItem.output ? outputCaptured : stopped, undefined).pipe(
                  Effect.asVoid,
                )
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-bg-stop-one"),
            text: BG_PROMPT,
          }),
        );
        yield* harness.firstTerminal;
        const stop = harness.runtime.stopBackgroundTask;
        if (stop === undefined) return yield* Effect.die("Codex must stop background commands.");
        // An id Codex is not running is refused before anything reaches Codex.
        const unknown = yield* Effect.exit(
          stop({ providerThread: harness.providerThread, taskId: "call-not-running" }),
        );
        assert.isTrue(Exit.isFailure(unknown));
        // The replay only accepts terminate for the command's own process id.
        yield* stop({ providerThread: harness.providerThread, taskId: BG_COMMAND_ITEM });
        yield* Deferred.await(stopped);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        yield* Deferred.await(outputCaptured);
        const completed = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.output !== undefined,
        );
        assert.equal(completed?.type, "turn_item.updated");
        if (
          completed?.type !== "turn_item.updated" ||
          completed.turnItem.type !== "command_execution"
        )
          return yield* Effect.die("Expected stopped command output.");
        assert.equal(completed.turnItem.status, "interrupted");
        assert.equal(completed.turnItem.output, "CODEX_BG_WAKE_DONE\n");
        assert.equal(completed.turnItem.exitCode, 130);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "keeps a stopped command terminal after the root settles while its sibling completes normally",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const lateFramesDrained = yield* Deferred.make<void>();
          const commandFrame = (
            method: "item/started" | "item/completed",
            item: Record<string, unknown>,
          ) => ({
            type: "emit_inbound" as const,
            frame: {
              method,
              params: {
                threadId: BG_NATIVE_THREAD,
                turnId: BG_NATIVE_TURN,
                startedAtMs: 1782622440500,
                completedAtMs: 1782622465500,
                item,
              },
            },
          });
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({
              scenario: "codex-bg-stop-late",
              entries: [
                ...codexReplayPreamble({
                  nativeThreadId: BG_NATIVE_THREAD,
                  nativeTurnId: BG_NATIVE_TURN,
                  prompt: BG_PROMPT,
                }),
                commandFrame("item/started", backgroundCommandItem("inProgress")),
                commandFrame("item/started", {
                  ...backgroundCommandItem("inProgress"),
                  id: "sibling-command",
                  processId: "4243",
                }),
                {
                  type: "expect_outbound",
                  frame: {
                    id: 4,
                    method: "thread/backgroundTerminals/terminate",
                    params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                  },
                },
                { type: "emit_inbound", frame: { id: 4, result: { terminated: true } } },
                {
                  type: "emit_inbound",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: BG_NATIVE_THREAD,
                      turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
                    },
                  },
                },
                commandFrame("item/started", backgroundCommandItem("inProgress")),
                commandFrame("item/completed", {
                  ...backgroundCommandItem("completed"),
                  status: "failed",
                  exitCode: 130,
                }),
                commandFrame("item/completed", {
                  ...backgroundCommandItem("completed"),
                  id: "sibling-command",
                  processId: "4243",
                }),
              ],
            }),
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              event.turnItem.nativeItemRef?.nativeId === "sibling-command"
                ? Deferred.succeed(
                    event.turnItem.status === "completed" ? lateFramesDrained : ready,
                    undefined,
                  ).pipe(Effect.asVoid)
                : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("stop-late"),
              text: BG_PROMPT,
            }),
          );
          yield* Deferred.await(ready);
          yield* harness.runtime.stopBackgroundTask!({
            providerThread: harness.providerThread,
            taskId: BG_COMMAND_ITEM,
          });
          yield* harness.firstTerminal;
          yield* Deferred.await(lateFramesDrained);
          const commands = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
              ? [event.turnItem]
              : [],
          );
          const stoppedCommand = commands.findLast(
            (item) => item.nativeItemRef?.nativeId === BG_COMMAND_ITEM,
          );
          assert.equal(stoppedCommand?.status, "interrupted");
          assert.equal(stoppedCommand?.output, "CODEX_BG_WAKE_DONE\n");
          assert.equal(stoppedCommand?.exitCode, 130);
          assert.equal(
            commands.findLast((item) => item.nativeItemRef?.nativeId === "sibling-command")?.status,
            "completed",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("stops only a native Codex child and ignores a stale Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = interruptSubagentCommandTranscript.entries
          .filter(
            (entry) =>
              entry.type !== "runtime_exit" &&
              !(
                "label" in entry &&
                ["turn/interrupt/root", "turn/completed/root"].includes(entry.label ?? "")
              ),
          )
          .map((entry) => {
            if (entry.type === "expect_outbound" || entry.type === "emit_inbound") {
              const frame = entry.frame as Record<string, unknown>;
              return typeof frame.id === "number" && frame.id > 4
                ? { ...entry, frame: { ...frame, id: frame.id - 1 } }
                : entry;
            }
            return entry;
          });
        const childReady = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-stop-one-child",
            entries,
          }),
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM
              ? Deferred.succeed(childReady, undefined).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("stop-one-child"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* Deferred.await(childReady);
        const child = harness.events.findLast((event) => event.type === "subagent.updated");
        assert.equal(child?.type, "subagent.updated");
        if (child?.type !== "subagent.updated") return;
        const stop = harness.runtime.stopSubagent!;
        const unknown = yield* Effect.exit(
          stop({ providerThread: harness.providerThread, nativeTaskId: "unknown" }),
        );
        assert.isTrue(Exit.isFailure(unknown));
        yield* stop({
          providerThread: harness.providerThread,
          nativeTaskId: child.subagent.nativeTaskRef!.nativeId!,
          requestedAt: DateTime.makeUnsafe(0),
        });
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "subagent.updated" && event.subagent.status === "interrupted",
          ),
        );
        yield* stop({
          providerThread: harness.providerThread,
          nativeTaskId: child.subagent.nativeTaskRef!.nativeId!,
        });
        assert.equal(
          harness.events.findLast((event) => event.type === "subagent.updated")?.subagent.status,
          "interrupted",
        );
        assert.lengthOf(harness.terminalEvents(), 0, "the parent must keep running");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("fails active turns and drains terminal events when a shared request times out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStarted = yield* Deferred.make<void>();
        const unsubscribeSent = yield* Deferred.make<void>();
        const interruptIndex = interruptSubagentCommandTranscript.entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "turn/interrupt/root",
        );
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-stalled-shared-request",
          entries: [
            ...interruptSubagentCommandTranscript.entries.slice(0, interruptIndex),
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "thread/unsubscribe",
                params: { threadId: INTERRUPT_NATIVE_THREAD },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
            event.turnItem.status === "running"
              ? Deferred.succeed(childStarted, undefined)
              : Effect.void,
          (method) =>
            method === "thread/unsubscribe"
              ? Deferred.succeed(unsubscribeSent, undefined).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-stalled-shared-request"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* Deferred.await(childStarted);
        const detach = yield* harness.runtime.unloadThread!({
          providerThread: harness.providerThread,
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(unsubscribeSent);
        yield* TestClock.adjust("60 seconds");
        const detachExit = yield* Fiber.await(detach);
        assert.isTrue(Exit.isFailure(detachExit));
        yield* harness.firstTerminal;
        const streamExit = yield* harness.eventStreamExit;
        assert.isTrue(Exit.isFailure(streamExit));
        if (Exit.isFailure(streamExit)) assert.include(Cause.pretty(streamExit.cause), "timed out");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");
        const childTerminal = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.threadId !== harness.threadId &&
            event.providerTurn.status === "failed",
        );
        assert.isAtLeast(childTerminal, 0);
        const rootTerminal = harness.terminalEvents()[0];
        assert.isTrue(
          rootTerminal?.status === "failed" && rootTerminal.childTurnsContinue === true,
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("wakes a settled parent once when its subagent finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* runSubagentWakeCase("codex-subagent-wake-settled", [
          { name: "alpha", endsInTurn: false },
        ]);
        // The parent's subagent item is still running when its root turn settles,
        // which is what lists it as pending work and shows the parent as waiting.
        const settledAt = harness.events.findIndex((event) => event.type === "turn.terminal");
        const itemAtSettle = harness.events
          .slice(0, settledAt)
          .findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.threadId === harness.threadId,
          );
        assert.equal(
          itemAtSettle?.type === "turn_item.updated" ? itemAtSettle.turnItem.status : undefined,
          "running",
        );
        assert.lengthOf(harness.continuationRequests, 1);
        const request = harness.continuationRequests[0]!;
        assert.equal(request.threadId, harness.threadId);
        assert.equal(request.providerThreadId, harness.providerThread.id);
        assert.equal(
          request.detail,
          "Subagent /root/alpha finished. Its <subagent_notification> in this thread has the full result.\n\n" +
            "Result tail:\nALPHA_DONE",
        );
        assert.equal(request.notification?.outcome, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("does not wake the parent for a subagent that finishes during its turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* runSubagentWakeCase("codex-subagent-wake-in-turn", [
          { name: "alpha", endsInTurn: true },
          { name: "beta", endsInTurn: false },
        ]);
        // Only beta, which outlived the root turn, wakes it.
        assert.deepEqual(
          harness.continuationRequests.map((request) => request.detail?.split(".")[0]),
          ["Subagent /root/beta finished"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("queues one wake per subagent when several finish together", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* runSubagentWakeCase("codex-subagent-wake-together", [
          { name: "alpha", endsInTurn: false },
          { name: "beta", endsInTurn: false },
        ]);
        assert.deepEqual(
          harness.continuationRequests.map((request) => request.detail?.split(".")[0]),
          ["Subagent /root/alpha finished", "Subagent /root/beta finished"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
