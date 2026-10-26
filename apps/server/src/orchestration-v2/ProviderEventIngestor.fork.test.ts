import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  ProviderDriverKind,
  ProviderInstanceId,
  PlanId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

import { makeHarness } from "./ThreadLaunchService.testHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layerTest = Layer.mergeAll(
  layerTestDatabase,
  layerTestStores,
  layerTestEventSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  layerGit,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestStores,
        layerTestEventSink,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        layerGit,
      ),
    ),
  ),
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  OrchestrationV2DomainEvent,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(layerTest);

layer("ProviderEventIngestorV2", (it) => {
  it.effect.each(["codex", "claudeAgent"])(
    "preserves implemented proposals when a cached adapter supersedes them (%s)",
    (driver) =>
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(yield* DateTime.now);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        });
        const plan: OrchestrationV2PlanArtifact = {
          id: PlanId.make("plan:implemented"),
          threadId: threadEvent.threadId,
          runId: null,
          nodeId: NodeId.make("node:implemented"),
          kind: "proposed_plan",
          status: "active",
          markdown: "# Implement this plan",
        };
        const ingest = (proposal: OrchestrationV2PlanArtifact) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId: threadEvent.threadId,
            event: {
              type: "plan.updated",
              driver: ProviderDriverKind.make(driver),
              plan: proposal,
            },
          });
        yield* eventSink.write({ events: [threadEvent] });
        yield* ingest(plan);
        // Implement updates persisted state without updating the adapter's cached proposal.
        yield* eventSink.write({
          events: [
            {
              ...threadEvent,
              id: yield* idAllocator.allocate.event({ threadId: threadEvent.threadId }),
              type: "plan.updated",
              payload: { ...plan, status: "completed" },
              nodeId: plan.nodeId,
            },
          ],
        });
        yield* ingest({ ...plan, status: "superseded", markdown: "Stale adapter copy" });
        const nextPlan = { ...plan, id: PlanId.make("plan:next") };
        yield* ingest(nextPlan);
        const plans = (yield* projectionStore.getThreadProjection(threadEvent.threadId)).plans;
        assert.equal(plans.find((candidate) => candidate.id === plan.id)?.status, "completed");
        const implemented = plans.find((candidate) => candidate.id === plan.id);
        assert.equal(implemented?.kind, "proposed_plan");
        if (implemented?.kind === "proposed_plan")
          assert.equal(implemented.markdown, plan.markdown);
        assert.equal(plans.find((candidate) => candidate.id === nextPlan.id)?.status, "active");
        // A proposal that was never implemented still supersedes normally.
        yield* ingest({ ...nextPlan, status: "superseded" });
        assert.equal(
          (yield* projectionStore.getPlan(plan.threadId, nextPlan.id))?.status,
          "superseded",
        );
      }),
  );

  it.effect.each([
    { parentRole: undefined, managed: false },
    { parentRole: "implementor", managed: false },
    { parentRole: undefined, managed: true },
  ] as const)(
    "updates provider child metadata without recreating its saved thread (%s)",
    ({ parentRole, managed }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        let rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `workflow-member-metadata-${parentRole ?? "unassigned"}-${managed}`,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
        });
        const issueRootId = ThreadId.make("thread:managed-issue-root");
        rootEvent = {
          ...rootEvent,
          payload: {
            ...rootEvent.payload,
            role: parentRole,
            ...(managed
              ? {
                  linkedIssue: {
                    host: "github.com",
                    repository: "tannerpolley/t3code",
                    repositoryId: "repo:8",
                    id: "issue:8",
                    nodeId: "node:8",
                    number: 8,
                    url: "https://github.com/tannerpolley/t3code/issues/8",
                    title: "Managed issue",
                  },
                  lineage: { ...rootEvent.payload.lineage, rootThreadId: issueRootId },
                }
              : {}),
          },
        };
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const checkedSink = EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) =>
            Effect.gen(function* () {
              if (
                input.events.some(
                  (event) =>
                    event.type === "thread.metadata-updated" &&
                    event.threadId === rootEvent.threadId,
                )
              ) {
                assert.include(
                  yield* executor.activeKeys,
                  managed ? issueRootId : rootEvent.threadId,
                );
              }
              return yield* eventSink.write(input);
            }),
        });
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
          Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
          Effect.provideService(EventSink.EventSinkV2, checkedSink),
        );
        const {
          role: _parentRole,
          linkedIssue: _linkedIssue,
          ...parentTemplate
        } = rootEvent.payload;
        const offered = {
          ...parentTemplate,
          id: childThreadId,
          creationSource: "provider" as const,
          title: "Inspect checkout",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent" as const,
            rootThreadId: rootEvent.threadId,
          },
        };
        const ingest = (appThread: OrchestrationV2AppThread) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId: rootEvent.threadId,
            event: { type: "app_thread.created", driver: CODEX_DRIVER, appThread },
          });
        yield* eventSink.write({ events: [rootEvent] });
        const created = yield* Effect.all([ingest(offered), ingest(offered)], {
          concurrency: "unbounded",
        });
        // Spawning a native subagent leaves the parent's stored role as it was.
        assert.deepEqual(
          created.flat().map((stored) => stored.event.type),
          ["thread.created"],
        );
        assert.equal((yield* projectionStore.getThread(rootEvent.threadId)).role, parentRole);
        assert.isUndefined((yield* projectionStore.getThread(childThreadId)).role);
        assert.equal((yield* projectionStore.getThreadShell(rootEvent.threadId))?.role, parentRole);
        assert.deepEqual(
          (yield* ingest(offered)).map((stored) => stored.event.type),
          [],
        );
        const saved = {
          ...offered,
          archivedAt: now,
          deletedAt: now,
          activeProviderThreadId: rootEvent.payload.activeProviderThreadId,
          branch: "user/checkout",
        };
        yield* eventSink.write({
          events: [
            {
              ...rootEvent,
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              threadId: childThreadId,
              type: "thread.deleted",
              payload: saved,
            },
          ],
        });
        for (const metadata of [
          { title: "Review checkout", modelSelection },
          { title: "Review checkout", modelSelection: { ...modelSelection, model: "gpt-6.1-sol" } },
        ]) {
          const updated = yield* ingest({ ...offered, ...metadata });
          assert.deepEqual(
            updated.map((stored) => stored.event.type),
            ["thread.metadata-updated"],
          );
          const thread = yield* projectionStore.getThread(childThreadId);
          assert.deepEqual(thread, { ...saved, ...metadata, updatedAt: thread.updatedAt });
        }
        const latest = {
          title: "Review checkout",
          modelSelection: {
            ...modelSelection,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        };
        assert.deepEqual(
          (yield* ingest({ ...offered, ...latest })).map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        // A role the provider reports later arrives on its original snapshot. It
        // fills the missing role, keeps the newer title and model, and never
        // replaces a role.
        assert.deepEqual(
          (yield* ingest({ ...offered, role: "implementor" })).map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        assert.deepEqual(yield* ingest({ ...offered, ...latest, role: "reviewer" }), []);
        const thread = yield* projectionStore.getThread(childThreadId);
        assert.deepEqual(thread, {
          ...saved,
          ...latest,
          role: "implementor",
          updatedAt: thread.updatedAt,
        });
      }),
  );
});

function syncModelDuringThreadChanges(issueLinked: boolean) {
  const harness = makeHarness();
  const dependencies = Layer.mergeAll(
    harness.layer,
    ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  );
  const testLayer = dependencies.pipe(
    Layer.provideMerge(ProviderEventIngestor.layer.pipe(Layer.provide(dependencies))),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const rootEvent = yield* threadCreatedEvent(now);
    if (rootEvent.type !== "thread.created") {
      throw new Error("Expected a thread.created fixture event");
    }
    const childThreadId = idAllocator.derive.threadFromProviderThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-late-model-subagent",
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId: rootEvent.threadId,
    });
    const ingest = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
      ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event,
      });
    yield* eventSink.write({
      events: [
        {
          ...rootEvent,
          payload: {
            ...rootEvent.payload,
            repositoryOrchestration: {
              ...DEFAULT_REPOSITORY_WORK_SETTINGS,
              host: "github.com",
              repository: "owner/repo",
              repositoryId: "repo:model-sync",
              projectId: rootEvent.payload.projectId,
              launchCommandId: CommandId.make("model-sync-root"),
              revision: 1,
              paused: false,
              publishStatusComments: false,
              publishCloseoutComments: false,
              milestones: [],
              suspendedIssues: [],
            },
          },
        },
      ],
    });
    yield* ingest({
      type: "app_thread.created",
      driver: CODEX_DRIVER,
      appThread: {
        ...rootEvent.payload,
        id: childThreadId,
        title: "review design",
        creationSource: "provider",
        role: "reviewer",
        ...(issueLinked
          ? {
              linkedIssue: {
                host: "github.com",
                repository: "owner/repo",
                repositoryId: "repo:model-sync",
                id: "issue:model-sync",
                nodeId: "node:model-sync",
                number: 97,
                url: "https://github.com/owner/repo/issues/97",
                title: "Model sync",
              },
            }
          : {}),
        modelSelection: {
          ...modelSelection,
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
      },
    });
    const subagentUpdated = {
      type: "subagent.updated",
      driver: CODEX_DRIVER,
      subagent: {
        id: NodeId.make("node:late-model-subagent"),
        threadId: rootEvent.threadId,
        runId: null,
        parentNodeId: NodeId.make("node:root"),
        origin: "provider_native",
        createdBy: "agent",
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the design",
        title: "review design",
        model: "gpt-6.1-sol",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    } satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];

    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    class HeldTestLock extends Context.Reference<ThreadId | null>("test/model-sync-lock", {
      defaultValue: () => null,
    }) {}
    class UserUpdate extends Context.Reference<boolean>("test/model-sync-user-update", {
      defaultValue: () => false,
    }) {}
    const modelReady = yield* Deferred.make<void>();
    const releaseModel = yield* Deferred.make<void>();
    const updateBlocked = yield* Deferred.make<void>();
    let modelLockKey: ThreadId | null = null;
    const withLock = locks.withLock.bind(locks);
    using _locks = vi
      .spyOn(locks, "withLock")
      .mockImplementation(<A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          // The command must wait for the same child lock as the native model write.
          if ((yield* UserUpdate) && key === modelLockKey)
            yield* Deferred.succeed(updateBlocked, undefined);
          return yield* withLock(key, effect.pipe(Effect.provideService(HeldTestLock, key)));
        }),
      );
    const originalWrite = eventSink.write.bind(eventSink);
    using _write = vi.spyOn(eventSink, "write").mockImplementation((input) =>
      Effect.gen(function* () {
        if (
          input.events.some(
            (event) =>
              event.type === "thread.model-selection-updated" && event.threadId === childThreadId,
          )
        ) {
          modelLockKey = yield* HeldTestLock;
          yield* Deferred.succeed(modelReady, undefined);
          yield* Deferred.await(releaseModel);
        }
        return yield* originalWrite(input);
      }),
    );
    const publishing = yield* ingest(subagentUpdated).pipe(Effect.forkChild);
    yield* Effect.raceFirst(Deferred.await(modelReady), Fiber.join(publishing));
    const editing = yield* Effect.gen(function* () {
      if (!issueLinked)
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-native-child"),
          threadId: childThreadId,
          title: "New user title",
        });
      yield* threads.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("reduce-native-child-permissions"),
        threadId: childThreadId,
        runtimeMode: "approval-required",
      });
    }).pipe(Effect.provideService(UserUpdate, true), Effect.forkChild);
    // A shared lock queues the edit; separate locks let it commit before model sync.
    yield* Effect.raceFirst(Deferred.await(updateBlocked), Fiber.join(editing));
    yield* Deferred.succeed(releaseModel, undefined);
    yield* Fiber.join(publishing);
    yield* Fiber.join(editing);
    const after = yield* projectionStore.getThread(childThreadId);
    assert.deepEqual(
      { title: after.title, runtimeMode: after.runtimeMode, model: after.modelSelection.model },
      {
        title: issueLinked ? "review design" : "New user title",
        runtimeMode: "approval-required",
        model: "gpt-6.1-sol",
      },
    );
  }).pipe(Effect.provide(testLayer));
}

it.effect("preserves a native child's rename and runtime mode during model sync", () =>
  syncModelDuringThreadChanges(false),
);

it.effect("preserves an issue-linked child's runtime mode during model sync", () =>
  syncModelDuringThreadChanges(true),
);
