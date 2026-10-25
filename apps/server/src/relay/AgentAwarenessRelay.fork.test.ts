import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("relay-thread");
const PROJECT_ID = ProjectId.make("relay-project");
const NOW = "2026-09-04T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const PublishPayload = Schema.Struct({ state: Schema.NullOr(RelayAgentActivityState) });
const decodePublishPayload = Schema.decodeUnknownSync(Schema.fromJsonString(PublishPayload));
const unused = () => Effect.die("Unexpected test dependency call");

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly readRecords?: ThreadManagementService.ThreadManagementService["Service"]["getThreadRecords"];
    readonly projectionStore?: ProjectionStore.ProjectionStoreV2["Service"];
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.linked === false
      ? []
      : [
          [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
          [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")],
        ],
  );
  const secretReads: string[] = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        secretReads.push(name);
        if (options.failSecretRead?.(name)) {
          return Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: name,
              cause: "temporary read failure",
            }),
          );
        }
        return Effect.succeed(Option.fromUndefinedOr(values.get(name)));
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const catchUp = { shellSnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    listActiveSubagentThreadIds: () => Effect.succeed([]),
    getThreadShell: (threadId) =>
      Effect.sync(() => shellReads.push(threadId)).pipe(
        Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
      ),
    getShellSnapshot: () =>
      Effect.sync(() => {
        catchUp.shellSnapshotReads += 1;
        return { schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [] };
      }),
    listOlderSettledThreads: unused,
    awaitBackgroundTasks: unused,
    readShellSnapshot: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: options.readRecords ?? (() => Effect.die("unused record read")),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    getProjectThread: unused,
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    requestUserInput: unused,
    respondToPendingRequest: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const publications: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly state: RelayAgentActivityState | null;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected a serialized activity publish payload"));
      }
      const payload = decodePublishPayload(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      publications.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        state: payload.state,
      });
      return Promise.resolve(
        options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
      );
    },
    { preconnect: () => {} },
  );
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("relay-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      snapshot: Effect.succeed({ projects: [] } as never),
      getShell: unused,
      listShells: unused,
      getById: () =>
        Effect.succeed(
          Option.some({
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          }),
        ),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(
      Layer.merge(
        NodeCrypto.layer,
        options.projectionStore === undefined
          ? ProjectionStore.layerMemory
          : Layer.succeed(ProjectionStore.ProjectionStoreV2, options.projectionStore),
      ),
    ),
  );
  return { relay, secrets, secretReads, currentShell, shellReads, publications, catchUp };
});

describe("AgentAwarenessRelay", () => {
  it.effect.each([false, true])(
    "settles a routed relay request, hidden within the window=%s",
    (hide) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const parentId = ThreadId.make("settling-parent");
        const parent = yield* Ref.make(
          shell({
            id: parentId,
            status: "interrupted",
            activeRunId: null,
            activityRunStatus: null,
          }),
        );
        const child = shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("settling-request"),
            kind: "user_input",
            createdAt: now,
            routedTo: parentId,
          },
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        });
        const { relay, publications } = yield* makeTestRelay({
          readShell: (id) => (id === parentId ? Ref.get(parent) : Effect.succeed(child)),
        });
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 0);
        yield* TestClock.adjust("2999 millis");
        yield* relay.drain;
        assert.equal(publications.length, 0);
        if (hide) {
          yield* Ref.update(parent, (current) => ({ ...current, status: "running" as const }));
          yield* relay.publishThread(THREAD_ID);
        }
        yield* TestClock.adjust("1 milli");
        yield* relay.drain;
        assert.equal(publications.length, hide ? 0 : 1);
        if (!hide) assert.equal(publications[0]?.state?.phase, "waiting_for_input");
        yield* TestClock.adjust("10 seconds");
        yield* relay.drain;
        assert.equal(publications.length, hide ? 0 : 1);
      }),
  );

  it.effect("publishes an unrouted input immediately", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("unrouted"),
            kind: "user_input",
            createdAt: yield* DateTime.now,
          },
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "waiting_for_input");
    }),
  );

  it.effect.each([
    { answered: false, queuedResume: false },
    { answered: false, queuedResume: true },
    { answered: true, queuedResume: false },
  ])(
    "re-evaluates child input on a parent-only event, answered=$answered, queuedResume=$queuedResume",
    ({ answered, queuedResume }) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, publications, shellReads } = yield* makeTestRelay({
          projectionStore: store,
          readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
          readRecords: (threadId, fields, filter) =>
            store.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        const parentId = ThreadId.make("orchestrator");
        const childId = ThreadId.make("routed-child");
        const runId = RunId.make("parent-run");
        const requestId = RuntimeRequestId.make("child-question");
        const now = yield* DateTime.now;
        const parent = { ...shell(), id: parentId, lastVisitedAt: null };
        const child = {
          ...parent,
          id: childId,
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent" as const,
          },
        };
        const run = {
          id: runId,
          threadId: parentId,
          ordinal: 1,
          providerInstanceId: parent.providerInstanceId,
          modelSelection: parent.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("parent-message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const request = {
          id: requestId,
          nodeId: NodeId.make("question-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          routedTo: parentId,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: null,
        };
        const seed: OrchestrationV2DomainEvent[] = [
          {
            id: EventId.make("parent-created"),
            type: "thread.created",
            threadId: parentId,
            occurredAt: now,
            payload: parent,
          },
          {
            id: EventId.make("child-created"),
            type: "thread.created",
            threadId: childId,
            occurredAt: now,
            payload: child,
          },
          {
            id: EventId.make("parent-running"),
            type: "run.updated",
            threadId: parentId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("child-request"),
            type: "runtime-request.updated",
            threadId: childId,
            occurredAt: now,
            payload: request,
          },
          {
            id: EventId.make("delegated-child"),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: now,
            payload: {
              id: NodeId.make("delegated-task"),
              threadId: parentId,
              runId,
              parentNodeId: NodeId.make("root"),
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: parent.providerInstanceId,
              providerThreadId: null,
              childThreadId: childId,
              nativeTaskRef: null,
              prompt: "Inspect",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ];
        for (const event of seed) yield* store.apply(event);
        yield* relay.publishThread(childId);
        assert.equal(publications.length, 0);
        if (answered)
          yield* store.apply({
            id: EventId.make("child-answered"),
            type: "runtime-request.updated",
            threadId: childId,
            occurredAt: now,
            payload: { ...request, status: "resolved", resolvedAt: now },
          });
        yield* relay.start();
        yield* Queue.take(pulls);
        for (const id of ["parent-stopped", "parent-stopped-again"]) {
          const event: OrchestrationV2DomainEvent = {
            id: EventId.make(id),
            type: "run.updated",
            threadId: parentId,
            occurredAt: now,
            payload: { ...run, status: "interrupted", completedAt: now },
          };
          yield* store.apply(event);
          yield* Queue.offer(events, event);
          yield* Queue.take(pulls);
          yield* relay.drain;
          yield* TestClock.adjust("3 seconds");
          yield* relay.drain;
        }
        const inputs = publications.filter(
          (publication) => publication.state?.threadId === childId,
        );
        assert.equal(inputs.length, answered ? 0 : 1);
        if (answered) assert.equal(shellReads.filter((id) => id === childId).length, 1);
        if (!answered) assert.equal(inputs[0]?.state?.phase, "waiting_for_input");
        if (!answered) {
          // Resuming the parent removes its child's owner card without the tombstone debounce.
          const resumed = {
            id: EventId.make("parent-resumed"),
            type: queuedResume ? "run.created" : "run.updated",
            threadId: parentId,
            occurredAt: now,
            payload: queuedResume
              ? {
                  ...run,
                  id: RunId.make("queued-parent-run"),
                  ordinal: 2,
                  status: "queued",
                  startedAt: null,
                }
              : run,
          } satisfies OrchestrationV2DomainEvent;
          yield* store.apply(resumed);
          yield* Queue.offer(events, resumed);
          yield* Queue.take(pulls);
          yield* relay.drain;
          const childPublications = publications.filter(
            (publication) => publication.url === inputs[0]?.url,
          );
          assert.equal(childPublications.length, 2);
          assert.isNull(childPublications[1]?.state);
        }
      }).pipe(Effect.scoped, Effect.provide(ProjectionStore.layerMemory)),
  );
});
