import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  NodeId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DontAskModeWorker from "./DontAskModeWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Requests are committed directly; no provider process runs"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "dont-ask-mode" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
  // The real settings service: the worker reacts to its change stream.
  ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provide(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-dont-ask-test-" })),
    ),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const threadId = ThreadId.make("thread:dont-ask");
const sessionId = ProviderSessionId.make("session:dont-ask");

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-dont-ask"),
    threadId,
    projectId: ProjectId.make("project:dont-ask"),
    title: "Away",
    modelSelection: { instanceId, model: "gpt-6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* projections.apply({
    id: EventId.make("attach-dont-ask"),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: "gpt-6",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
});

/** Commits a live request and its item, as a provider adapter does. */
const commitRequest = (name: string, ordinal: number, kind: "user_input" | "command") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`request:${name}`);
    const nodeId = NodeId.make(`node:${name}`);
    const item = {
      id: TurnItemId.make(`item:${name}`),
      threadId,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      requestId,
    } as const;
    const { storedEvents } = yield* sink.commitCommand({
      commandId: CommandId.make(`ask:${name}`),
      threadId,
      commandType: "provider-event.ingest",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId: sessionId },
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`item:${name}`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload:
            kind === "user_input"
              ? {
                  ...item,
                  type: "user_input_request",
                  questions: [
                    {
                      id: "database",
                      header: "Database",
                      question: "Which database?",
                      options: [
                        { label: "SQLite (Recommended)", description: "Embedded" },
                        { label: "Postgres", description: "Server" },
                      ],
                    },
                    { id: "notes", header: "Notes", question: "Anything else?", options: [] },
                  ],
                }
              : { ...item, type: "approval_request", requestKind: "command" },
        },
      ],
    });
    return { requestId, storedEvents };
  });

/** Waits for the persisted resolution and returns what was recorded. */
const awaitResolved = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* sink.stream({ afterSequence: 0, eventType: "runtime-request.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "resolved",
      ),
      Stream.runHead,
    );
    return yield* projections.getRuntimeResponseContext(threadId, requestId);
  });

const setDontAskMode = (dontAskMode: boolean) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ dontAskMode });
  });

it.effect("answers new questions and approvals while on", () =>
  Effect.gen(function* () {
    yield* createThread;
    yield* Layer.build(DontAskModeWorker.workerLive);
    yield* setDontAskMode(true);
    const question = yield* commitRequest("question", 1, "user_input");
    const approval = yield* commitRequest("approval", 2, "command");

    const answered = yield* awaitResolved(question.requestId);
    assert.deepEqual(answered.request?.answers, {
      database: `SQLite (Recommended)\n\n${DontAskModeWorker.DONT_ASK_NOTE}`,
      notes: DontAskModeWorker.DONT_ASK_NOTE,
    });
    assert.equal(
      answered.item?.type === "user_input_request" ? answered.item.respondedBy : undefined,
      "dont_ask_mode",
    );
    const approved = yield* awaitResolved(approval.requestId);
    assert.equal(approved.request?.decision, "accept");
    assert.equal(
      approved.item?.type === "approval_request" ? approved.item.respondedBy : undefined,
      "dont_ask_mode",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("switching on answers requests that were already waiting", () =>
  Effect.gen(function* () {
    yield* createThread;
    // Committed before the worker subscribes, so only the switch-on sweep can answer them.
    const question = yield* commitRequest("question", 1, "user_input");
    const approval = yield* commitRequest("approval", 2, "command");
    yield* Layer.build(DontAskModeWorker.workerLive);
    yield* setDontAskMode(true);

    assert.equal((yield* awaitResolved(question.requestId)).request?.status, "resolved");
    assert.equal((yield* awaitResolved(approval.requestId)).request?.decision, "accept");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("switching off leaves new requests waiting for the user", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread;
    yield* setDontAskMode(true);
    yield* setDontAskMode(false);
    const { handle } = yield* DontAskModeWorker.make;
    const approval = yield* commitRequest("approval", 1, "command");
    for (const stored of approval.storedEvents) yield* handle(stored.event);

    assert.equal(
      (yield* projections.getRuntimeRequest(threadId, approval.requestId))?.status,
      "pending",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("switching off stops a sweep that is already answering", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread;
    const requests = [
      yield* commitRequest("question", 1, "user_input"),
      yield* commitRequest("approval", 2, "command"),
      yield* commitRequest("approval-2", 3, "command"),
    ];
    // Holds the sweep right after its first answer.
    const answered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const { sweep } = yield* DontAskModeWorker.make.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, {
        ...orchestrator,
        dispatch: (command) =>
          orchestrator
            .dispatch(command)
            .pipe(
              Effect.tap(() =>
                Deferred.succeed(answered, undefined).pipe(
                  Effect.flatMap((first) => (first ? Deferred.await(resume) : Effect.void)),
                ),
              ),
            ),
      }),
    );
    yield* setDontAskMode(true);
    const sweeping = yield* Effect.forkChild(sweep);
    yield* Deferred.await(answered);
    yield* setDontAskMode(false);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(sweeping);

    const statuses = yield* Effect.forEach(requests, ({ requestId }) =>
      projections.getRuntimeRequest(threadId, requestId).pipe(Effect.map((r) => r?.status)),
    );
    assert.deepEqual([...statuses].sort(), ["pending", "pending", "resolved"]);
  }).pipe(Effect.provide(testLayer)),
);
