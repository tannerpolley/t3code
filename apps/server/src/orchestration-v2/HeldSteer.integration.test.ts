import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const capabilities = CodexProviderCapabilitiesV2;

// The provider session starts turns without reporting them, so each test
// decides when the root provider turn goes live (or ends before it does).
const runScenario = <E>(
  name: string,
  body: (input: {
    readonly started: ReadonlyArray<ProviderAdapterV2TurnInput>;
    readonly steered: ReadonlyArray<MessageId>;
    readonly events: Queue.Queue<ProviderAdapterV2Event>;
    readonly cwd: string;
  }) => Effect.Effect<void, E, OrchestratorV2 | OrchestrationEffectWorkerV2 | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`held-steer-${name}`);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const started: ProviderAdapterV2TurnInput[] = [];
      const steered: MessageId[] = [];
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) => Effect.sync(() => void started.push(turn)),
              steerTurn: (turn) => Effect.sync(() => void steered.push(turn.message.messageId)),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* body({ started, steered, events, cwd }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry({ name }, makeSingleLayer(adapter), {
            runEffectWorker: false,
          }),
        ),
      );
    }),
  );

const threadId = ThreadId.make("thread:held-steer");
const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

/** Start the first run; its provider turn is not live yet. */
const startFirstRun = (cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:held-steer"),
      title: "Held steer",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    assert.equal(run.status, "running");
    assert.equal(projection.providerTurns.length, 0);
    return run;
  });

const sendSteer = (id: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments: [],
      // What the web client sends when the server resolves command context.
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "steer",
      createdBy: "user",
      creationSource: "web",
    });
  });

const providerTurnFor = (
  turn: ProviderAdapterV2TurnInput,
  status: "running" | "completed",
  now: DateTime.Utc,
) => ({
  type: "provider_turn.updated" as const,
  driver,
  providerTurn: {
    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" as const },
    ordinal: turn.providerTurnOrdinal,
    status,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
  },
});

it.effect("delivers an early steer as a steer once the provider turn goes live", () =>
  runScenario("delivered", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const first = yield* startFirstRun(cwd);
      yield* sendSteer("steer");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue"),
        threadId,
        messageId: MessageId.make("message:queue"),
        text: "queue",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const held = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const heldSteer = held.find((run) => run.userMessageId === "message:steer")!;
      assert.equal(heldSteer.status, "queued");
      assert.equal(heldSteer.steerTargetRunId, first.id);
      const queued = held.find((run) => run.userMessageId === "message:queue")!;
      assert.equal(queued.steerTargetRunId, undefined);

      const promoted = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === heldSteer.id &&
          event.payload.status === "cancelled",
      );
      yield* Queue.offer(events, providerTurnFor(started[0]!, "running", yield* DateTime.now));
      yield* Fiber.join(promoted);
      yield* worker.drain();

      assert.deepEqual(steered, [MessageId.make("message:steer")]);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "user_message" && candidate.messageId === "message:steer",
      );
      assert.equal(item?.type === "user_message" ? item.inputIntent : null, "steer");
      assert.equal(item?.runId, first.id);
      // An explicit queue still waits for the turn to finish.
      assert.equal(projection.runs.find((run) => run.id === queued.id)?.status, "queued");
      assert.equal(started.length, 1);
    }),
  ),
);

it.effect("runs an early steer as a queued turn when the turn ends before going live", () =>
  runScenario("turn-ends-first", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      const first = yield* startFirstRun(cwd);
      yield* sendSteer("steer");
      const now = yield* DateTime.now;
      const turn = providerTurnFor(started[0]!, "completed", now);
      const waiting = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.id &&
          event.payload.status === "waiting",
      );
      yield* Queue.offer(events, turn);
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: first.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(waiting);
      // Never starts during checkpoint capture: still queued while waiting.
      const duringCapture = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        duringCapture.runs.find((run) => run.userMessageId === "message:steer")?.status,
        "queued",
      );
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();

      assert.deepEqual(steered, []);
      assert.equal(started.length, 2);
      assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
    }),
  ),
);

it.effect("steers a live turn directly without holding it", () =>
  runScenario("live", ({ started, steered, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
      yield* startFirstRun(cwd);
      const live = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* Queue.offer(events, providerTurnFor(started[0]!, "running", yield* DateTime.now));
      yield* Fiber.join(live);
      yield* sendSteer("steer");
      yield* worker.drain();

      assert.deepEqual(steered, [MessageId.make("message:steer")]);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 1);
    }),
  ),
);
