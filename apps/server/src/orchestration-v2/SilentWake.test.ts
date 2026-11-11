import { ProviderAdapterCapabilitiesError } from "@t3tools/provider-core/server/ProviderAdapter";
import { presentThreadShell } from "../../../../packages/client-runtime/src/state/models.ts";
import { resolveThreadActivity } from "../../../../packages/client-runtime/src/state/forkThreadActivity.ts";
import * as TestClock from "effect/testing/TestClock";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import { EnvironmentId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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
      yield* wakeThread(orchestrator, input.threadId);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze"),
        threadId: input.threadId,
        snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
      });
      const wake = (yield* orchestrator.getThreadProjection(input.threadId)).runs[0]!;
      const nudged = yield* complete(orchestrator, sink, input.threadId, wake);
      assert.isTrue((yield* deliver(orchestrator, input.threadId, wake)).replayed);
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
        yield* reply(sink, input.threadId, followup, "Build succeeded", "reply");
      }
      const flagged = yield* complete(orchestrator, sink, input.threadId, followup);
      const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(input.threadId)).thread.silentWakeAttention,
        flagged.thread.silentWakeAttention,
      );
      assert.equal(
        (yield* outbox.listByCommandId(CommandId.make(`silent-wake-check:${wake.id}`))).filter(
          (effect) => effect.request.type === "provider-turn.start",
        ).length,
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
    if (scenario === "child")
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
    yield* finish(sink, input.threadId, run);
    yield* deliver(orchestrator, input.threadId, run);
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

const wakeThread = (o: Orchestrator.OrchestratorV2Shape, threadId: ThreadId) =>
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
) =>
  Effect.gen(function* () {
    yield* finish(sink, threadId, run);
    yield* deliver(o, threadId, run);
    return yield* o.getThreadProjection(threadId);
  });

it.effect("attention leaves a completed issue worker outcome as done", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const l = yield* ThreadLaunch.ThreadLaunchService;
    const input = launchInput({ command: "create", thread: "issue" });
    yield* l.launch(input);
    yield* wakeThread(o, input.threadId);
    const p = yield* o.getThreadProjection(input.threadId);
    const nudged = yield* complete(o, s, input.threadId, p.runs[0]!);
    const final = yield* complete(o, s, input.threadId, nudged.runs.at(-1)!);
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
        yield* wakeThread(o, input.threadId);
        const p = yield* o.getThreadProjection(input.threadId);
        const r = p.runs[0]!;
        yield* finish(s, input.threadId, r);
        const committed = yield* o.getThreadProjection(input.threadId);
        assert.isFalse(committed.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
        const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          CommandId.make(`silent-wake-check:${r.id}`),
        );
        assert.equal(effects[0]?.request.type, "run.silence.check");
        assert.isTrue(committed.turnItems.some((i) => i.type === "system_notice"));
      }).pipe(Effect.provide(makeHarness({ databaseLayer }).layer));
      yield* Effect.gen(function* () {
        const o = yield* Orchestrator.OrchestratorV2;
        yield* o.recoverDelegatedTasks;
        yield* o.resumeQueuedRuns;
        const before = yield* o.getThreadProjection(input.threadId);
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const effects = yield* outbox.listByCommandId(
          CommandId.make(`silent-wake-check:${before.runs[0]!.id}`),
        );
        yield* executor.execute(effects[0]!);
        yield* executor.execute(effects[0]!);
        const p = yield* o.getThreadProjection(input.threadId);
        assert.equal(p.messages.filter((m) => m.silentWakeFollowupOfRunId !== undefined).length, 1);
      }).pipe(Effect.provide(executorLayer(makeHarness({ databaseLayer }).layer)));
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
    yield* reply(s, childId, original, "Original result", "original-reply");
    yield* complete(o, s, childId, original);
    yield* o.recoverDelegatedTasks;
    yield* o.dispatch({
      type: "delegated_task.completion-delivery.acknowledge",
      commandId: CommandId.make("ack"),
      parentThreadId: input.threadId,
      taskId: task.id,
      observedByRunId: r.id,
    });
    yield* wakeThread(o, childId);
    const woke = (yield* o.getThreadProjection(childId)).runs.at(-1)!;
    assert.isDefined(woke.delegatedTaskId);
    const nudged = yield* complete(o, s, childId, woke);
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

it.effect.each(["pending", "claimed"] as const)(
  "a claimed child result prevents an extra wake: %s",
  (deliveryState) =>
    Effect.gen(function* () {
      const o = yield* Orchestrator.OrchestratorV2;
      const s = yield* EventSink.EventSinkV2;
      const l = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({ command: "create", thread: "claimed" });
      yield* l.launch(input);
      yield* wakeThread(o, input.threadId);
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
              completionDelivery: { state: deliveryState, observedByRunId: null },
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
      const after = yield* complete(o, s, input.threadId, r);
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
    yield* wakeThread(o, input.threadId);
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
    yield* finish(s, input.threadId, r);
    yield* deliver(o, input.threadId, r);
    const after = yield* o.getThreadProjection(input.threadId);
    assert.isFalse(after.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
  }).pipe(Effect.provide(makeHarness().layer)),
);

const deliver = (
  o: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  run: OrchestrationV2Run,
) =>
  o.dispatch({
    type: "run.silence.check",
    commandId: CommandId.make(`silent-wake-check:${run.id}`),
    threadId,
    runId: run.id,
  });
const finish = (s: EventSink.EventSinkV2Shape, threadId: ThreadId, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return yield* s.write({
      commandId: CommandId.make("command:runtime-reconcile:" + run.id),
      events: [
        {
          id: EventId.make("finish:" + run.id),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
  });
it.effect("remote delegated child must not get a nudge or attention", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2,
      s = yield* EventSink.EventSinkV2,
      l = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({ command: "create", thread: "remote" }),
      linkOrigin: { sessionId: "linked", label: "Linked" },
      delegatedFrom: {
        environmentId: EnvironmentId.make("remote"),
        threadId: ThreadId.make("parent"),
        title: "Parent",
      },
    };
    yield* l.launch(input);
    yield* wakeThread(o, input.threadId);
    let p = yield* o.getThreadProjection(input.threadId);
    yield* finish(s, input.threadId, p.runs[0]!);
    yield* deliver(o, input.threadId, p.runs[0]!);
    p = yield* o.getThreadProjection(input.threadId);
    assert.equal(p.runs.length, 1);
    assert.isUndefined(p.thread.silentWakeAttention);
  }).pipe(Effect.provide(makeHarness().layer)),
);
it.effect("concurrent user queue does not reuse the nudge run", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>(),
      resume = yield* Deferred.make<void>();
    let pause = false;
    const adapter = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () =>
        Effect.gen(function* () {
          if (pause) {
            pause = false;
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(resume);
          }
          return CodexProviderCapabilitiesV2;
        }),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("disabled"),
    };
    const harness = makeHarness({ adapters: [adapter] });
    yield* Effect.gen(function* () {
      const o = yield* Orchestrator.OrchestratorV2,
        s = yield* EventSink.EventSinkV2,
        l = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({ command: "create", thread: "race" });
      yield* l.launch(input);
      yield* wakeThread(o, input.threadId);
      const p = yield* o.getThreadProjection(input.threadId);
      pause = true;
      const sender = yield* o
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("user"),
          threadId: input.threadId,
          messageId: MessageId.make("user"),
          text: "User next task",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      yield* finish(s, input.threadId, p.runs[0]!);
      const delivery = yield* deliver(o, input.threadId, p.runs[0]!).pipe(Effect.forkChild);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(sender);
      yield* Fiber.join(delivery);
      const a = yield* o.getThreadProjection(input.threadId);
      const nudge = a.messages.find((message) => message.silentWakeFollowupOfRunId !== undefined);
      if (nudge)
        assert.notEqual(nudge.runId, a.messages.find((message) => message.id === "user")?.runId);
      assert.equal(a.runs.length, 2);
      assert.equal(a.messages.filter((m) => m.silentWakeFollowupOfRunId).length, 0);
    }).pipe(Effect.provide(harness.layer));
  }),
);
const executorLayer = (dependencies: ReturnType<typeof makeHarness>["layer"]) =>
  EffectWorker.layerExecutor.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        dependencies,
        Layer.mock(RunFinalizationService.RunFinalizationService)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
        Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
      ),
    ),
  );

const reply = (
  sink: EventSink.EventSinkV2Shape,
  threadId: ThreadId,
  run: OrchestrationV2Run,
  text: string,
  id: string,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(id),
          type: "message.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: MessageId.make(id),
            threadId,
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
  });

it.effect.each(["before completion", "after completion"])(
  "Stop suppresses a delayed silence follow-up: %s",
  (timing) =>
    Effect.gen(function* () {
      const o = yield* Orchestrator.OrchestratorV2;
      const s = yield* EventSink.EventSinkV2;
      yield* (yield* ThreadLaunch.ThreadLaunchService).launch(
        launchInput({ command: "create", thread: "stop" }),
      );
      const threadId = launchInput({ command: "create", thread: "stop" }).threadId;
      yield* wakeThread(o, threadId);
      const run = (yield* o.getThreadProjection(threadId)).runs[0]!;
      const stop = o.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId,
        stopDelegatedTasks: false,
      });
      if (timing === "before completion") {
        yield* stop;
        yield* TestClock.adjust("1 second");
      }
      yield* finish(s, threadId, run);
      if (timing === "after completion") yield* stop;
      yield* deliver(o, threadId, run);
      const after = yield* o.getThreadProjection(threadId);
      assert.isTrue(
        after.turnItems.some((i) => i.type === "run_interrupt_request" && i.runId === run.id),
      );
      assert.equal(after.runs.length, 1);
      assert.isFalse(after.messages.some((m) => m.silentWakeFollowupOfRunId !== undefined));
    }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect("a Stop of an earlier run does not suppress a later silence follow-up", () =>
  Effect.gen(function* () {
    const o = yield* Orchestrator.OrchestratorV2;
    const s = yield* EventSink.EventSinkV2;
    const input = launchInput({ command: "create", thread: "earlier-stop", message: "First task" });
    yield* (yield* ThreadLaunch.ThreadLaunchService).launch(input);
    const first = (yield* o.getThreadProjection(input.threadId)).runs[0]!;
    yield* o.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop"),
      threadId: input.threadId,
      stopDelegatedTasks: false,
    });
    yield* finish(s, input.threadId, first);
    yield* TestClock.adjust("1 second");
    yield* wakeThread(o, input.threadId);
    const run = (yield* o.getThreadProjection(input.threadId)).runs.at(-1)!;
    yield* finish(s, input.threadId, run);
    yield* deliver(o, input.threadId, run);
    assert.equal(
      (yield* o.getThreadProjection(input.threadId)).messages.filter(
        (m) => m.silentWakeFollowupOfRunId === run.id,
      ).length,
      1,
    );
  }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect.each(["failure", "defect"] as const)(
  "a failed silence follow-up flags attention once and releases later lifecycle effects: %s",
  (fault) => {
    let failing = false;
    let lookups = 0;
    const adapter = {
      instanceId: ProviderInstanceId.make("alternate"),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => {
        lookups++;
        if (!failing) return Effect.succeed(CodexProviderCapabilitiesV2);
        return fault === "defect"
          ? Effect.die("Unexpected capabilities lookup defect")
          : Effect.fail(
              new ProviderAdapterCapabilitiesError({
                driver: ProviderDriverKind.make("codex"),
                cause: "Temporary capabilities lookup failure",
              }),
            );
      },
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("disabled"),
    };
    const dependencies = executorLayer(
      makeHarness({
        adapters: [
          {
            ...adapter,
            instanceId: ProviderInstanceId.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          },
          adapter,
        ],
      }).layer,
    );
    return Effect.gen(function* () {
      const o = yield* Orchestrator.OrchestratorV2;
      const s = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const input = launchInput({ command: "create", thread: "failed-followup" });
      yield* (yield* ThreadLaunch.ThreadLaunchService).launch(input);
      yield* wakeThread(o, input.threadId);
      const p = yield* o.getThreadProjection(input.threadId);
      const run = p.runs[0]!;
      yield* outbox.cancelUnsettled({
        threadId: input.threadId,
        effectTypes: ["provider-turn.start", "thread-title.generate"],
        reason: "Setup completed",
      });
      yield* finish(s, input.threadId, run);
      yield* s.write({
        events: [
          {
            id: EventId.make("selection"),
            type: "thread.metadata-updated",
            threadId: input.threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...p.thread,
              providerInstanceId: adapter.instanceId,
              modelSelection: { ...p.thread.modelSelection, instanceId: adapter.instanceId },
            },
          },
        ],
      });
      const check = (yield* outbox.listByCommandId(
        CommandId.make(`silent-wake-check:${run.id}`),
      ))[0]!;
      yield* outbox.enqueue([
        {
          id: "later-lifecycle",
          commandId: CommandId.make("later"),
          threadId: input.threadId,
          request: { type: "scheduled-tasks.cleanup" },
        },
      ]);
      let laterDelivered = false;
      const workerLayer = EffectWorker.layerWithOptions().pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
              execute: (effect) =>
                effect.request.type === "run.silence.check"
                  ? executor.execute(effect)
                  : Effect.sync(() => {
                      if (effect.id === "later-lifecycle") laterDelivered = true;
                    }),
            }),
          ),
        ),
      );
      failing = true;
      yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
        Effect.flatMap((w) => w.drain()),
        Effect.provide(workerLayer),
      );
      assert.isTrue(laterDelivered);
      const after = yield* o.getThreadProjection(input.threadId);
      assert.equal(after.runs.length, 1);
      assert.equal(
        after.thread.silentWakeAttention?.reason,
        "The automatic follow-up could not be sent",
      );
      const shell = (yield* o.getThreadShell(input.threadId))!;
      const presented = presentThreadShell(EnvironmentId.make("test"), shell);
      assert.equal(resolveThreadActivity(presented), "failed");
      assert.equal(
        presented.runtime?.silentWakeAttention?.reason,
        after.thread.silentWakeAttention?.reason,
      );
      const calls = lookups;
      failing = false;
      yield* executor.execute(check);
      assert.equal(lookups, calls);
      assert.deepEqual(yield* o.getThreadProjection(input.threadId), after);
      const sql = yield* SqlClient.SqlClient;
      const receipts =
        yield* sql`SELECT status FROM orchestration_command_receipts WHERE command_id = ${`silent-wake-check:${run.id}`}`;
      assert.equal(receipts[0]?.status, "accepted");
      const effects = yield* outbox.listByCommandId(check.commandId);
      assert.equal(effects[0]?.status, "succeeded");
      assert.equal(effects[0]?.attemptCount, 1);
    }).pipe(Effect.provide(dependencies));
  },
);
