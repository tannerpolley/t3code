import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Maintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { makeHarness, launchInput } from "./ThreadLaunchService.testHarness.ts";
import { SILENT_WAKE_FOLLOWUP, SILENT_WAKE_ATTENTION } from "./SilentWake.ts";

it.effect.each([false, true])("nudges once and handles a follow-up reply: %s", (replied) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const input = launchInput({ command: "create", thread: "silent" });
    yield* launches.launch(input);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("wake"),
      threadId: input.threadId,
      messageId: MessageId.make("wake"),
      text: "Background command finished",
      notification: {
        source: { kind: "command" },
        outcome: "completed",
        summary: "Command finished",
      },
      attachments: [],
      createdBy: "agent",
      creationSource: "provider",
      dispatchMode: { type: "queue_after_active" },
    });
    const complete = (run: OrchestrationV2Run) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const afterSequence = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              id: EventId.make(`complete:${run.id}`),
              type: "run.updated",
              threadId: input.threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
        if (!(replied && String(run.userMessageId).startsWith("silent-wake-followup:"))) {
          yield* sink.stream({ afterSequence, eventType: "turn-item.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "turn-item.updated" &&
                stored.event.payload.runId === run.id &&
                stored.event.payload.type === "system_notice",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        }
        const command = {
          type: "run.silence.check" as const,
          commandId: CommandId.make(`silent-wake-check:${run.id}`),
          threadId: input.threadId,
          runId: run.id,
        };
        yield* orchestrator.dispatch(command);
        const replay = yield* orchestrator.dispatch(command);
        assert.isTrue(replay.replayed);
        return yield* orchestrator.getThreadProjection(input.threadId);
      });
    const wake = (yield* orchestrator.getThreadProjection(input.threadId)).runs[0]!;
    const nudged = yield* complete(wake);
    const followups = nudged.messages.filter(
      (message) => message.silentWakeFollowupOfRunId !== undefined,
    );
    assert.equal(followups.length, 1);
    assert.equal(followups[0]?.createdBy, "system");
    assert.equal(followups[0]?.text, SILENT_WAKE_FOLLOWUP);
    assert.equal(
      (yield* outbox.listByCommandId(CommandId.make(`silent-wake-check:${wake.id}`))).filter(
        (effect) => effect.request.type === "provider-turn.start",
      ).length,
      1,
    );
    const followup = nudged.runs.find((run) => run.userMessageId === followups[0]!.id)!;
    if (replied) {
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("reply"),
            type: "message.updated",
            threadId: input.threadId,
            runId: followup.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("reply"),
              threadId: input.threadId,
              runId: followup.id,
              nodeId: followup.rootNodeId,
              createdBy: "agent",
              creationSource: "provider",
              role: "assistant",
              text: "Build succeeded",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    }
    const flagged = yield* complete(followup);
    const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(input.threadId)).thread.silentWakeAttention,
      flagged.thread.silentWakeAttention,
    );
    assert.equal(
      (yield* outbox.listByCommandId(CommandId.make(`silent-wake-check:${wake.id}`))).length,
      1,
    );
    assert.equal(flagged.runs.length, 2);
    assert.equal(flagged.runs.at(-1)?.status, "completed");
    assert.equal(
      flagged.thread.silentWakeAttention?.reason,
      replied ? undefined : SILENT_WAKE_ATTENTION,
    );
    assert.equal(
      (yield* orchestrator.getThreadShell(input.threadId))?.status,
      replied ? "completed" : "failed",
    );
    assert.equal(
      (yield* orchestrator.getThreadShell(input.threadId))?.latestRunStatus,
      replied ? undefined : "completed",
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("next"),
      threadId: input.threadId,
      messageId: MessageId.make("next"),
      text: "Continue",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    assert.isUndefined(
      (yield* orchestrator.getThreadProjection(input.threadId)).thread.silentWakeAttention,
    );
  }).pipe(
    Effect.provide(
      Maintenance.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            harness.layer,
            EventStore.layer.pipe(Layer.provide(harness.layer)),
            ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
          ),
        ),
      ),
    ),
  );
});

it.effect.each([
  "user",
  "agent",
  "brief",
  "queued",
  "background",
  "child",
  "pending-result",
  "question",
  "approval",
] as const)("does not nudge a silent run with %s origin or pending work", (scenario) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const input = launchInput({ command: "create", thread: "control", message: "Do the work" });
    yield* launches.launch(input);
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    const run = projection.runs[0]!;
    const message = projection.messages[0]!;
    const now = yield* DateTime.now;
    const wake = !["user", "agent", "brief"].includes(scenario);
    yield* sink.write({
      events: [
        {
          id: EventId.make("origin"),
          type: "message.updated",
          threadId: input.threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...message,
            createdBy: scenario === "user" ? "user" : "agent",
            creationSource: scenario === "user" ? "web" : wake ? "provider" : "mcp",
            ...(wake
              ? {
                  notification: {
                    source: { kind: "command" },
                    outcome: "completed",
                    summary: "Build finished",
                  },
                }
              : {}),
          },
        },
      ],
    });
    if (scenario === "queued")
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queued"),
        threadId: input.threadId,
        messageId: MessageId.make("queued"),
        text: "Next task",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
    if (scenario === "background") {
      const provider = projection.providerThreads[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("background"),
            type: "provider-thread.updated",
            threadId: input.threadId,
            occurredAt: now,
            payload: {
              ...provider,
              pendingBackgroundTasks: [{ taskId: "build", kind: "command", description: "Build" }],
            },
          },
        ],
      });
    }
    if (scenario === "child" || scenario === "pending-result")
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("child"),
        parentThreadId: input.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Check the build",
        modelSelection: run.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
    if (scenario === "pending-result") {
      const task = (yield* orchestrator.getThreadProjection(input.threadId)).subagents[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("pending-result"),
            type: "subagent.updated",
            threadId: input.threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              ...task,
              status: "completed",
              completedAt: now,
              result: "Build passed",
              completionDelivery: { state: "pending", observedByRunId: null },
            },
          },
        ],
      });
    }
    if (scenario === "question" || scenario === "approval")
      yield* sink.write({
        events: [
          {
            id: EventId.make("request"),
            type: "runtime-request.updated",
            threadId: input.threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("request"),
              nodeId: run.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: scenario === "question" ? "user_input" : "permission",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:control"),
      events: [
        {
          id: EventId.make("complete"),
          type: "run.updated",
          threadId: input.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "run.silence.check",
      commandId: CommandId.make("check"),
      threadId: input.threadId,
      runId: run.id,
    });
    const settled = yield* orchestrator.getThreadProjection(input.threadId);
    assert.isFalse(
      settled.messages.some((candidate) => candidate.silentWakeFollowupOfRunId !== undefined),
    );
    assert.isTrue(
      settled.turnItems.some(
        (item) =>
          item.type === "system_notice" && item.message === "The turn ended without a reply",
      ),
    );
  }).pipe(Effect.provide(harness.layer));
});
