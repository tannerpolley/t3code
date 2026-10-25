import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  EnvironmentId,
  MessageId,
  RunId,
  EventId,
  NodeId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerFailingReleaseEventSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(layerTestEventSink));

interface FlakyReleaseWrites {
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  readonly failures: Queue.Queue<void>;
  readonly pauseRequestWrites?: {
    readonly paused: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            const pause = flaky.pauseRequestWrites;
            if (
              pause !== undefined &&
              input.events.some((event) => event.type === "runtime-request.updated")
            ) {
              yield* Deferred.succeed(pause.paused, undefined);
              yield* Deferred.await(pause.resume);
            }
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerBeforeUnchangedWriteEventSink = (before: Ref.Ref<Effect.Effect<void>>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        writeIfProviderThreadUnchanged: (input) =>
          Ref.getAndSet(before, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(delegate.writeIfProviderThreadUnchanged(input)),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly eventQueues: ReadonlyMap<
    string,
    Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>
  >;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  unloadedNativeThreadIds: [],
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
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
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeThreadId?: string;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = input.nativeThreadId ?? "native-thread";
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId,
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}

const makeProviderAdapter = Effect.fnUntraced(function* (
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly backgroundTasksEndWithProcess?: boolean;
    readonly hangSessionScopeClose?: boolean;
    readonly startTurn?: Effect.Effect<void>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly beforeClose?: Effect.Effect<void>;
    readonly eventStreamEnded?: Deferred.Deferred<void>;

    readonly spawnBeforeOpen?: boolean;
    readonly scopeCloseReached?: Deferred.Deferred<void>;
  } = {},
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const countClose = Effect.addFinalizer(() =>
    (options.beforeClose ?? Effect.void).pipe(
      Effect.andThen(
        Ref.update(state, (current) => ({
          ...current,
          closeCount: current.closeCount + 1,
        })),
      ),
    ),
  );
  // Registered after countClose so it runs first on scope close, wedging the
  // close before the closeCount finalizer, like a provider process that never
  // yields its message stream.
  const hangClose = Effect.addFinalizer(() =>
    (options.scopeCloseReached === undefined
      ? Effect.void
      : Deferred.succeed(options.scopeCloseReached, undefined)
    ).pipe(Effect.andThen(Effect.never)),
  );
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.spawnBeforeOpen === true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen === true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen !== true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        });
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        if (options.spawnBeforeOpen !== true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }

        return {
          instanceId: ProviderInstanceId.make("codex"),
          driver: CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events).pipe(
                Stream.concat(
                  Stream.fromEffectDrain(
                    options.eventStreamEnded === undefined
                      ? Effect.void
                      : Deferred.succeed(options.eventStreamEnded, undefined),
                  ),
                ),
              ),
          ...(options.backgroundTasksEndWithProcess === false
            ? {}
            : { backgroundTasksEndWithProcess: true as const }),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: () => options.hasPendingBackgroundWorkForThread!,
              }),
          ensureThread: () => unimplemented("ensureThread unused in test"),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(Effect.as(threadInput.providerThread)),
          startTurn: () => options.startTurn ?? Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })),
          unloadThread: ({ providerThread }) =>
            (options.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  unloadedNativeThreadIds: [
                    ...current.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});

function layerTest(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs?: number;
  readonly maxIdlePinMs?: number;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly flakyReleaseWrites?: FlakyReleaseWrites;
  readonly pauseAttachWrite?: Parameters<typeof layerPausingAttachEventSink>[0];
  readonly beforeUnchangedWrite?: Ref.Ref<Effect.Effect<void>>;
  readonly pauseResolve?: {
    readonly armed: Ref.Ref<boolean>;
    readonly paused: Deferred.Deferred<void>;
  };
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
  readonly backgroundTasksEndWithProcess?: boolean;
  readonly hangSessionScopeClose?: boolean;
  readonly startTurn?: Effect.Effect<void>;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly beforeClose?: Effect.Effect<void>;
  readonly eventStreamEnded?: Deferred.Deferred<void>;
  readonly spawnBeforeOpen?: boolean;
  readonly scopeCloseReached?: Deferred.Deferred<void>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
}) {
  const layerConfiguredEventSink =
    input.flakyReleaseWrites !== undefined
      ? layerFlakyReleaseEventSink(input.flakyReleaseWrites)
      : input.pauseAttachWrite !== undefined
        ? layerPausingAttachEventSink(input.pauseAttachWrite)
        : input.beforeUnchangedWrite !== undefined
          ? layerBeforeUnchangedWriteEventSink(input.beforeUnchangedWrite)
          : input.failReleaseEventWrites
            ? layerFailingReleaseEventSink
            : layerTestEventSink;
  const layerRegistry = Layer.unwrap(
    makeProviderAdapter(input.state, {
      failEventStream: input.failEventStream ?? false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
      ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
      ...(input.hasPendingBackgroundWork === undefined
        ? {}
        : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
      ...(input.hasPendingBackgroundWorkForThread === undefined
        ? {}
        : { hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread }),
      ...(input.backgroundTasksEndWithProcess === undefined
        ? {}
        : { backgroundTasksEndWithProcess: input.backgroundTasksEndWithProcess }),
      ...(input.hangSessionScopeClose === undefined
        ? {}
        : { hangSessionScopeClose: input.hangSessionScopeClose }),
      ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
      ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
      ...(input.beforeClose === undefined ? {} : { beforeClose: input.beforeClose }),
      ...(input.eventStreamEnded === undefined ? {} : { eventStreamEnded: input.eventStreamEnded }),
      ...(input.spawnBeforeOpen === undefined ? {} : { spawnBeforeOpen: input.spawnBeforeOpen }),
      ...(input.scopeCloseReached === undefined
        ? {}
        : { scopeCloseReached: input.scopeCloseReached }),
    }).pipe(Effect.map(ProviderAdapterRegistry.layerSingle)),
  );
  const layerConfiguredMcpRegistry =
    input.pauseResolve === undefined
      ? layerTestMcpRegistry
      : layerPausingMcpRegistry(input.pauseResolve);
  const layerProviderEventIngestorTest = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerConfiguredEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveBranchName: () => Effect.succeed(null),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestStores,
    layerConfiguredEventSink,
    IdAllocator.layer,
    layerConfiguredMcpRegistry,
    McpProviderSessions.layer,
    ProviderSessionManager.layerWithOptions({
      ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerRegistry.pipe(Layer.provideMerge(McpProviderSessions.layer)),
          CommandOutputHub.layer.pipe(
            Layer.provide(Layer.merge(layerConfiguredEventSink, layerTestStores)),
          ),
          layerConfiguredEventSink,
          IdAllocator.layer,
          layerProviderEventIngestorTest,
          layerConfiguredMcpRegistry,
          layerTestStores,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const layerTestMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provide(NodeServices.layer),
);

const layerPausingMcpRegistry = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const delegate = yield* McpSessionRegistry.McpSessionRegistry;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...delegate,
        resolve: (rawToken) =>
          Ref.getAndSet(pause.armed, false).pipe(
            Effect.flatMap((armed) =>
              armed
                ? Deferred.succeed(pause.paused, undefined).pipe(Effect.andThen(Effect.never))
                : delegate.resolve(rawToken),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestMcpRegistry));

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const turnItem = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.threadId,
      runId: null,
      nodeId,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
    };
    const events = [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "turn-item.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: turnItem,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    const providerEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: CODEX_DRIVER,
        threadId: input.threadId,
        runtimeRequest: request,
      },
      {
        type: "node.updated" as const,
        driver: CODEX_DRIVER,
        node,
      },
      {
        type: "turn_item.updated" as const,
        driver: CODEX_DRIVER,
        turnItem,
      },
    ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
    return { events, providerEvents, requestId, nodeId };
  });
}

it.effect("ProviderSessionManagerV2 cleans up an interrupted open whose scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const handshakeStarted = yield* Deferred.make<void>();
    const scopeCloseReached = yield* Deferred.make<void>();
    const releaseRetry = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-interrupted-hung-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkChild);
      yield* Deferred.await(handshakeStarted);
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);

      const interrupter = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
      yield* Deferred.await(scopeCloseReached);

      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(interrupter);
      yield* Deferred.succeed(releaseRetry, undefined);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* Ref.get(state)).openCount, 1);

      const stopping = yield* manager.shutdown.pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(stopping);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          beforeOpen: () =>
            Deferred.isDone(handshakeStarted).pipe(
              Effect.flatMap((retry) =>
                retry
                  ? Deferred.await(releaseRetry)
                  : Deferred.succeed(handshakeStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    ),
              ),
            ),
          spawnBeforeOpen: true,
          hangSessionScopeClose: true,
          scopeCloseReached,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 bounds layer shutdown when a provider scope never closes", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const scopeCloseReached = yield* Deferred.make<void>();
    const stopping = yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-hung-layer-shutdown");
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        }),
        modelSelection,
        runtimePolicy,
      });
    }).pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, hangSessionScopeClose: true, scopeCloseReached }),
      ),
      Effect.forkDetach,
    );
    yield* Deferred.await(scopeCloseReached);
    yield* TestClock.adjust("4999 millis");
    assert.isUndefined(stopping.pollUnsafe());
    // Per-session close and the aggregate scope each get at most five seconds.
    yield* TestClock.adjust("5001 millis");
    assert.isDefined(stopping.pollUnsafe());
    yield* Fiber.join(stopping);
    assert.equal((yield* Ref.get(state)).closeCount, 0);
  }),
);

it.effect("ProviderSessionManagerV2 ignores provider exits after SIGTERM", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const eventStreamEnded = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-sigterm");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(
        Stream.catchCause(() => Stream.empty),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);

      // Provider CLIs receive SIGTERM with the server and may report a failed
      // turn before the server finishes shutting down.
      process.emit("SIGTERM");
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "sigterm-thread",
        }),
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "sigterm-turn",
        }),
        runOrdinal: 1,
        failureItemOrdinal: 1,
        status: "failed",
        failure: makeProviderFailure({ class: "transport_error" }),
        threadDisposition: "broken",
      });
      yield* Queue.end(adapterQueue!);
      yield* Deferred.await(eventStreamEnded);

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal(
        (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
        "ready",
      );
      yield* manager.release({ providerSessionId, reason: "idle_timeout" });

      assert.isEmpty(yield* Fiber.join(collected));
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, eventStreamEnded })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 idle release clears a Monitor that holds completion", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-idle-monitor");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = {
        ...makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
        pendingBackgroundTasks: [
          { taskId: "bbcaa29ff", kind: "monitor" as const, awaited: true as const },
        ],
      };
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: providerThread,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: RunId.make("run-idle-monitor"),
              threadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: providerThread.id,
              userMessageId: MessageId.make("message-idle-monitor"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const before = yield* projectionStore.getThreadProjection(threadId);
      assert.isTrue(
        backgroundWorkHoldsCompletion(
          derivePendingBackgroundWork({
            latestRun: before.runs.at(-1),
            providerThreads: before.providerThreads,
            turnItems: before.turnItems,
          }),
        ),
      );
      const afterSequence = yield* eventSink.latestSequence({ threadId });

      yield* TestClock.adjust("1 second");
      yield* eventSink
        .stream({ threadId, afterSequence, eventType: "provider-session.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-session.updated" &&
              stored.event.payload.status === "stopped",
          ),
          Stream.runHead,
        );

      const after = yield* projectionStore.getThreadProjection(threadId);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.deepEqual(after.providerThreads[0]?.pendingBackgroundTasks, []);
      assert.isFalse(
        backgroundWorkHoldsCompletion(
          derivePendingBackgroundWork({
            latestRun: after.runs.at(-1),
            providerThreads: after.providerThreads,
            turnItems: after.turnItems,
          }),
        ),
      );
      const rosterClear = yield* eventSink
        .stream({ threadId, afterSequence, eventType: "provider-thread.updated" })
        .pipe(Stream.runHead);
      assert.isTrue(Option.isSome(rosterClear));
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          // Claude's Monitor does not pin an idle session.
          hasPendingBackgroundWork: Effect.succeed(false),
        }),
      ),
    );
  }),
);

it.effect.each([
  { reason: "manual_shutdown", replaced: false },
  { reason: "runtime_error", replaced: false },
  { reason: "server_shutdown", replaced: false },
  { reason: "manual_shutdown", replaced: true },
  { reason: "runtime_error", replaced: true },
  { reason: "server_shutdown", replaced: true },
] as const)(
  "ProviderSessionManagerV2 $reason respects roster ownership (replaced=$replaced)",
  ({ reason, replaced }) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeReached = yield* Deferred.make<void>();
      const resumeClose = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread-release-roster-${reason}`);
        const detachedId = ThreadId.make(`thread-detached-roster-${reason}`);
        const childId = ThreadId.make(`thread-app-owned-child-${reason}`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const otherSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: childId,
        });
        const monitor = [{ taskId: "monitor", kind: "monitor" as const }];
        const providerThreads = [
          {
            ...makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
              nativeThreadId: "attached",
            }),
            status: "active" as const,
            pendingBackgroundTasks: monitor,
          },
          {
            ...makeProviderThread({
              idAllocator,
              threadId: detachedId,
              providerSessionId,
              now,
              nativeThreadId: "detached",
            }),
            pendingBackgroundTasks: monitor,
          },
          {
            ...makeProviderThread({
              idAllocator,
              threadId: detachedId,
              providerSessionId: otherSessionId,
              now,
              nativeThreadId: "other-session",
            }),
            pendingBackgroundTasks: monitor,
          },
          {
            ...makeProviderThread({
              idAllocator,
              threadId: childId,
              providerSessionId: otherSessionId,
              now,
              nativeThreadId: "app-owned-child",
            }),
            pendingBackgroundTasks: monitor,
          },
        ];
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: detachedId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: childId, now }),
            ...(yield* Effect.forEach(providerThreads, (providerThread) =>
              Effect.gen(function* () {
                return {
                  id: yield* idAllocator.allocate.event({
                    threadId: providerThread.appThreadId!,
                  }),
                  type: "provider-thread.updated" as const,
                  threadId: providerThread.appThreadId!,
                  occurredAt: now,
                  payload: providerThread,
                };
              }),
            )),
          ],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        yield* manager.open({
          threadId: detachedId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.detach({
          providerSessionId,
          threadId: detachedId,
          revokeMcpCredential: true,
        });
        const release = yield* manager
          .release({ providerSessionId, reason })
          .pipe(Effect.forkChild);
        let attachedRoster = reason === "server_shutdown" ? monitor : [];
        if (replaced) {
          yield* Deferred.await(closeReached);
          // A resumed thread reuses the session id while the old process is closing.
          yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
          attachedRoster = [{ taskId: "resumed-monitor", kind: "monitor" }];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "provider-thread.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...providerThreads[0]!,
                  status: "active",
                  pendingBackgroundTasks: attachedRoster,
                },
              },
            ],
          });
          yield* Deferred.succeed(resumeClose, undefined);
        }
        yield* Fiber.join(release);

        const attached = yield* projectionStore.getThreadProjection(threadId);
        const detached = yield* projectionStore.getThreadProjection(detachedId);
        const child = yield* projectionStore.getThreadProjection(childId);
        assert.deepEqual(attached.providerThreads[0]?.pendingBackgroundTasks, attachedRoster);
        assert.equal(
          attached.providerSessions.at(-1)?.status,
          replaced ? "ready" : reason === "runtime_error" ? "error" : "stopped",
        );
        // The closed process's own tasks end with it, even when a replacement opens.
        assert.deepEqual(
          detached.providerThreads.find((thread) => thread.providerSessionId === providerSessionId)
            ?.pendingBackgroundTasks,
          reason === "server_shutdown" ? monitor : [],
        );
        assert.deepEqual(
          detached.providerThreads.find((thread) => thread.providerSessionId === otherSessionId)
            ?.pendingBackgroundTasks,
          monitor,
        );
        assert.deepEqual(child.providerThreads[0]?.pendingBackgroundTasks, monitor);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            beforeClose: replaced
              ? Deferred.succeed(closeReached, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeClose)),
                )
              : Effect.void,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 persists release when session scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-hung-close",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-hung-close",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 1000, hangSessionScopeClose: true })),
    );
  }),
);

const openSessionWithBackgroundCommand = (fixtureName: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const now = yield* DateTime.now;
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId: yield* idAllocator.allocate.project({ fixtureName }),
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const otherProviderSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const pendingBackgroundTasks = [
      { taskId: "dev-server", kind: "command", description: "python3 -m http.server" },
    ] as const;
    const providerThreads = [
      {
        ...makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
        pendingBackgroundTasks,
      },
      {
        ...makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId: otherProviderSessionId,
          now,
          nativeThreadId: "native-thread-other-session",
        }),
        pendingBackgroundTasks,
      },
    ];
    const writeProviderThread = (payload: OrchestrationV2ProviderThread) =>
      Effect.gen(function* () {
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload,
            },
          ],
        });
      });
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
    });
    yield* Effect.forEach(providerThreads, writeProviderThread);
    yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
    const rosters = Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      return providerThreads.map((seeded) =>
        (
          projection.providerThreads.find((thread) => thread.id === seeded.id)
            ?.pendingBackgroundTasks ?? []
        ).map((task) => task.taskId),
      );
    });
    return { threadId, providerSessionId, providerThreads, writeProviderThread, rosters };
  });

it.effect("ProviderSessionManagerV2 ends only the released session's own open tool calls", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const { threadId, providerSessionId, providerThreads } =
        yield* openSessionWithBackgroundCommand("provider-session-manager-detach-items");
      // A workspace handoff detaches mid-call. The released session's provider
      // thread also holds a native subagent and a call a replacement session
      // started after the release; another session's provider thread holds a
      // call of its own.
      const base = (name: string, providerThread: OrchestrationV2ProviderThread) => ({
        id: TurnItemId.make(`turn-item:${name}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      });
      const toolCall = (name: string, providerThread: OrchestrationV2ProviderThread) =>
        ({
          ...base(name, providerThread),
          type: "dynamic_tool",
          toolName: "mcp__t3-code__t3_worktree_return_to_root",
          input: null,
          output: null,
        }) satisfies OrchestrationV2TurnItem;
      const released = providerThreads[0]!;
      const items: ReadonlyArray<OrchestrationV2TurnItem> = [
        toolCall("tool", released),
        { ...base("command", released), type: "command_execution", input: "sleep 60" },
        {
          ...base("subagent", released),
          type: "subagent",
          subagentId: NodeId.make("node-released-subagent"),
          origin: "provider_native",
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          childThreadId: null,
          prompt: "Review the diff",
          result: null,
        },
        {
          ...toolCall("replacement", released),
          startedAt: DateTime.add(now, { minutes: 1 }),
        },
        toolCall("other-session", providerThreads[1]!),
      ];
      yield* eventSink.write({
        events: items.map((payload) => ({
          id: EventId.make(`event:${payload.id}`),
          type: "turn-item.updated" as const,
          threadId,
          occurredAt: now,
          payload,
        })),
      });

      yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });

      const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"]);
      assert.deepStrictEqual(
        items.map((item) => turnItems.find((stored) => stored.id === item.id)?.status),
        ["interrupted", "interrupted", "running", "running", "running"],
      );
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
      ),
    );
  }),
);

it.effect.each(["live", "app_owned"] as const)(
  "ProviderSessionManagerV2 marks pending %s runtime requests non-live on release",
  (capability) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-request-expire",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-request-expire",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const pendingRequest = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId,
          providerSessionId,
          providerThread,
          now,
        });
        yield* eventSink.write({
          events: pendingRequest.events.map((event) =>
            event.type === "runtime-request.updated"
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    responseCapability: { type: capability, providerSessionId },
                  },
                }
              : event,
          ),
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.release({
          providerSessionId,
          reason: "runtime_error",
          detail: "process exited",
        });

        const projection = yield* projectionStore.getThreadProjection(threadId);
        const request = projection.runtimeRequests.at(-1);
        const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
        const requestTurnItem = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request?.id,
        );

        assert.equal(request?.status, "expired");
        assert.equal(request?.responseCapability.type, "not_resumable");
        assert.equal(requestNode?.status, "failed");
        assert.equal(requestTurnItem?.status, "failed");
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

// Adapts the fork reaper tests to upstream's manager-owned residency timer.
it.effect.each([0, 1] as const)(
  "ProviderSessionManagerV2 uses idleAgentSessionMinutes=%s",
  (minutes) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settings = ServerSettings.layerTest({ idleAgentSessionMinutes: minutes });
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = ThreadId.make(`thread-idle-setting-${minutes}`);
        const providerSessionId = yield* allocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: allocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        yield* TestClock.adjust(minutes === 0 ? "31 minutes" : "1 minute");
        const session = yield* manager.get(providerSessionId);
        assert.equal(Option.isSome(session), minutes === 0);
        assert.equal((yield* Ref.get(state)).closeCount, minutes === 0 ? 0 : 1);
      }).pipe(Effect.provide(layerTest({ state, serverSettingsLayer: settings })));
    }),
);

it.effect("ProviderSessionManagerV2 unloads only old finished native children once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const parentId = ThreadId.make("thread:idle-native-parent");
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: parentId,
      });
      yield* sink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId: parentId, now }),
        ],
      });
      yield* manager.open({ threadId: parentId, providerSessionId, modelSelection, runtimePolicy });
      for (const status of ["completed", "running"] as const) {
        const childId = ThreadId.make(`thread:idle-native-${status}`);
        const nodeId = NodeId.make(`node:idle-native-${status}`);
        const child = yield* makeThreadCreatedEvent({
          idAllocator: allocator,
          threadId: childId,
          now,
        });
        const providerThread = {
          ...makeProviderThread({
            idAllocator: allocator,
            threadId: childId,
            providerSessionId,
            now,
          }),
          id: allocator.derive.providerThread({ driver: CODEX_DRIVER, nativeThreadId: status }),
          nativeThreadRef: { driver: CODEX_DRIVER, nativeId: status, strength: "strong" as const },
        };
        yield* sink.write({
          events: [
            {
              ...child,
              payload: {
                ...child.payload,
                lineage: {
                  parentThreadId: parentId,
                  rootThreadId: parentId,
                  relationshipToParent: "subagent",
                },
                forkedFrom: { type: "node", nodeId },
              },
            },
            {
              id: EventId.make(`event:idle-native-provider-${status}`),
              type: "provider-thread.updated",
              threadId: childId,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: EventId.make(`event:idle-native-task-${status}`),
              type: "subagent.updated",
              threadId: parentId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId: parentId,
                runId: null,
                parentNodeId: NodeId.make("node:idle-native-root"),
                origin: "provider_native",
                createdBy: "agent",
                driver: CODEX_DRIVER,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId: providerThread.id,
                childThreadId: childId,
                nativeTaskRef: null,
                prompt: "Review",
                title: "Review",
                model: modelSelection.model,
                status,
                result: status === "completed" ? "Done" : null,
                startedAt: now,
                completedAt: status === "completed" ? now : null,
                updatedAt: now,
              },
            },
          ],
        });
      }
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["completed"]);
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          serverSettingsLayer: ServerSettings.layerTest({ idleAgentSessionMinutes: 1 }),
          hasPendingBackgroundWork: Effect.succeed(true),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps a session with a pending question connected", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:idle-question");
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator: allocator,
        threadId,
        providerSessionId,
        now,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId, now })],
      });
      const pending = yield* makePendingRuntimeRequestEvents({
        idAllocator: allocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* sink.write({ events: pending.events });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          serverSettingsLayer: ServerSettings.layerTest({ idleAgentSessionMinutes: 1 }),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 applies an idle timeout change to existing sessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const changes = yield* Queue.unbounded<import("@t3tools/contracts").ServerSettings>();
    const settingsLayer = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const base = yield* ServerSettings.ServerSettingsService;
        return {
          ...base,
          subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
          updateSettings: (patch: import("@t3tools/contracts").ServerSettingsPatch) =>
            base
              .updateSettings(patch)
              .pipe(Effect.tap((settings) => Queue.offer(changes, settings))),
        };
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ idleAgentSessionMinutes: 0 })));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const threadId = ThreadId.make("thread:idle-setting-change");
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* sink.write({
        events: [
          yield* makeThreadCreatedEvent({
            idAllocator: allocator,
            threadId,
            now: yield* DateTime.now,
          }),
        ],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      yield* TestClock.adjust("40 seconds");
      yield* settings.updateSettings({ idleAgentSessionMinutes: 1 });
      yield* TestClock.adjust("20 seconds");
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerTest({ state, serverSettingsLayer: settingsLayer }), settingsLayer),
      ),
    );
  }),
);
