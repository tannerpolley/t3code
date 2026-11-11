import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { deriveIssueWorkStatus } from "../issues/IssueWorkStatus.ts";
import * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
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

it.effect.each([false, true])(
  "preserves snooze while nudging once and handles a follow-up reply: %s",
  (replied) => {
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
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze"),
        threadId: input.threadId,
        snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
      });
      const wake = (yield* orchestrator.getThreadProjection(input.threadId)).runs[0]!;
      const nudged = yield* complete(wake);
      assert.isNotNull(nudged.thread.snoozedUntil);
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
      assert.equal((yield* orchestrator.getThreadShell(input.threadId))?.status, "completed");
      assert.equal(
        deriveIssueWorkStatus({
          shell: (yield* orchestrator.getThreadShell(input.threadId))!,
          paused: false,
          waitingOnSubIssues: false,
          resultAvailable: true,
        }),
        "done",
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
  },
);

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
      const parent = yield* orchestrator.getThreadProjection(input.threadId);
      const task = parent.subagents[0]!;
      const item = parent.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === task.id,
      )!;
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
          {
            id: EventId.make("settled-child-item"),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
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

const wake = (o: Orchestrator.OrchestratorV2Shape, threadId: ThreadId) =>
  o.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("wake"),
    threadId,
    messageId: MessageId.make("wake"),
    text: "Background work completed",
    notification: { source: { kind: "command" }, outcome: "completed", summary: "Finished" },
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
  });
const complete = (
  o: Orchestrator.OrchestratorV2Shape,
  sink: EventSink.EventSinkV2Shape,
  threadId: ThreadId,
  run: OrchestrationV2Run,
  key: string,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:" + key),
      events: [
        {
          id: EventId.make("complete:" + key),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* o.dispatch({
      type: "run.silence.check",
      commandId: CommandId.make("silent-wake-check:" + run.id),
      threadId,
      runId: run.id,
    });
    return yield* o.getThreadProjection(threadId);
  });

it.effect("attention leaves a completed issue worker outcome as done", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const l = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({ command: "create", thread: "issue" });
    yield* l.launch(input);
    yield* wake(o, input.threadId);
    const p = yield* o.getThreadProjection(input.threadId);
    const nudged = yield* complete(o, s, input.threadId, p.runs[0]!, "first");
    const final = yield* complete(o, s, input.threadId, nudged.runs.at(-1)!, "second");
    const shell = yield* o.getThreadShell(input.threadId);
    const result = deriveIssueWorkStatus({
      shell: shell!,
      paused: false,
      waitingOnSubIssues: false,
      resultAvailable: true,
    });
    assert.isDefined(final.thread.silentWakeAttention);
    assert.equal(result, "done");
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("commits the silent-wake decision with completion and retains it after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* Layer.build(Sqlite.layerMemory);
      const databaseLayer = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(db, SqlClient.SqlClient),
      );
      const input = launchInput({ command: "create", thread: "restart" });
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        const s = yield* EventSink.EventSinkV2;
        const l = yield* ThreadLaunch.ThreadLaunchService;
        yield* l.launch(input);
        yield* wake(o, input.threadId);
        const p = yield* o.getThreadProjection(input.threadId);
        const r = p.runs[0]!;
        const now = yield* DateTime.now;
        // Runtime reconciliation bypasses the live subscriber, as a shutdown before delivery would.
        yield* s.write({
          commandId: CommandId.make("command:runtime-reconcile:lost"),
          events: [
            {
              id: EventId.make("lost-completion"),
              type: "run.updated",
              threadId: input.threadId,
              runId: r.id,
              occurredAt: now,
              payload: { ...r, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        const committed = yield* o.getThreadProjection(input.threadId);
        assert.isTrue(committed.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
        assert.isTrue(committed.turnItems.some((i) => i.type === "system_notice"));
      }).pipe(Effect.provide(makeHarness({ databaseLayer }).layer));
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        yield* o.recoverDelegatedTasks;
        yield* o.resumeQueuedRuns;
        const p = yield* o.getThreadProjection(input.threadId);

        assert.isTrue(p.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
      }).pipe(Effect.provide(makeHarness({ databaseLayer }).layer));
    }),
  ),
);
it.effect("reports a silent delegated wake to its parent without nudging the child", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const l = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({ command: "create", thread: "parent", message: "Work" });
    yield* l.launch(input);
    const parent = yield* o.getThreadProjection(input.threadId);
    const r = parent.runs[0]!;
    yield* o.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate"),
      parentThreadId: input.threadId,
      parentRunId: r.id,
      parentNodeId: r.rootNodeId!,
      task: "Check",
      modelSelection: r.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* o.getThreadProjection(input.threadId)).subagents[0]!;
    const childId = task.childThreadId!;
    const original = (yield* o.getThreadProjection(childId)).runs[0]!;
    const now = yield* DateTime.now;
    const reply = (run: OrchestrationV2Run, text: string, id: string) =>
      s.write({
        events: [
          {
            id: EventId.make(id),
            type: "message.updated",
            threadId: childId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: MessageId.make(id),
              threadId: childId,
              runId: run.id,
              nodeId: run.rootNodeId,
              role: "assistant",
              text,
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    yield* reply(original, "Original result", "original-reply");
    yield* complete(o, s, childId, original, "original");
    yield* o.recoverDelegatedTasks;
    yield* o.dispatch({
      type: "delegated_task.completion-delivery.acknowledge",
      commandId: CommandId.make("ack"),
      parentThreadId: input.threadId,
      taskId: task.id,
      observedByRunId: r.id,
    });
    yield* wake(o, childId);
    const woke = (yield* o.getThreadProjection(childId)).runs.at(-1)!;
    assert.isDefined(woke.delegatedTaskId);
    const nudged = yield* complete(o, s, childId, woke, "child-wake");
    assert.equal(nudged.runs.length, 2);
    assert.isFalse(nudged.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
    assert.isUndefined(nudged.thread.silentWakeAttention);
    assert.isTrue(nudged.turnItems.some((i) => i.type === "system_notice" && i.runId === woke.id));
    yield* o.recoverDelegatedTasks;
    const final = (yield* o.getThreadProjection(input.threadId)).subagents.find(
      (t) => t.id === woke.delegatedTaskId,
    )!;
    assert.equal(final.result, "Child task completed without an assistant result.");
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("a claimed child result prevents an extra wake", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const l = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({ command: "create", thread: "claimed" });
    yield* l.launch(input);
    yield* wake(o, input.threadId);
    const p = yield* o.getThreadProjection(input.threadId);
    const r = p.runs[0]!;
    yield* o.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("child"),
      parentThreadId: input.threadId,
      parentRunId: r.id,
      parentNodeId: r.rootNodeId!,
      task: "Check",
      modelSelection: r.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const parent = yield* o.getThreadProjection(input.threadId);
    const task = parent.subagents[0]!;
    const now = yield* DateTime.now;
    yield* s.write({
      events: [
        {
          id: EventId.make("claimed"),
          type: "subagent.updated",
          threadId: input.threadId,
          runId: r.id,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            completedAt: now,
            result: "OK",
            completionDelivery: { state: "claimed", observedByRunId: null },
          },
        },
      ],
    });
    const item = parent.turnItems.find((i) => i.type === "subagent" && i.subagentId === task.id);
    if (item)
      yield* s.write({
        events: [
          {
            id: EventId.make("claimed-item"),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: r.id,
            occurredAt: now,
            payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
          },
        ],
      });
    const after = yield* complete(o, s, input.threadId, r, "claimed");
    assert.isFalse(after.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("an active pull request watch prevents a silence nudge", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const l = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({ command: "create", thread: "prwatch" });
    yield* l.launch(input);
    yield* wake(o, input.threadId);
    const p = yield* o.getThreadProjection(input.threadId);
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const link = {
      host: "github.com",
      repository: "example/repo",
      number: 1,
      url: "https://github.com/example/repo/pull/1",
      source: "agent",
      linkedAt: iso,
      stack: null,
      snapshot: {
        state: "open",
        title: "Test",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: iso,
      },
      watch: {
        startedAt: iso,
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: iso,
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    } as const;
    yield* s.write({
      events: [
        {
          id: EventId.make("watch"),
          type: "thread.metadata-updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: { ...p.thread, pullRequests: [link] },
        },
      ],
    });
    const r = p.runs[0]!;
    yield* s.write({
      commandId: CommandId.make("command:runtime-reconcile:watch"),
      events: [
        {
          id: EventId.make("pr-complete"),
          type: "run.updated",
          threadId: input.threadId,
          runId: r.id,
          occurredAt: now,
          payload: { ...r, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* o.dispatch({
      type: "run.silence.check",
      commandId: CommandId.make("silent-wake-check:" + r.id),
      threadId: input.threadId,
      runId: r.id,
    });
    const after = yield* o.getThreadProjection(input.threadId);
    assert.isFalse(after.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
  }).pipe(Effect.provide(makeHarness().layer)),
);
