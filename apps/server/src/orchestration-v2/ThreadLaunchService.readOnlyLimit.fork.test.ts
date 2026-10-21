import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as IssueLinks from "../issues/IssueLinks.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_REPOSITORY_WORK_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ThreadRole,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "./ThreadLaunchService.testHarness.ts";

const reference = { host: "github.com", repository: "owner/repo" };
const rootId = ThreadId.make("read-only-root");
const issue = (number: number) => ({
  ...reference,
  repositoryId: "repo:read-only",
  id: `issue:${number}`,
  nodeId: `node:${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/owner/repo/issues/${number}`,
});
const reads = Layer.mock(IssueService.IssueService)({
  workRead: (input) =>
    Effect.succeed({
      issue: issue(input.number),
      state: "open",
      milestoneNumber: null,
      parent: null,
      subIssues: [],
      blockedBy: [],
      parentComplete: true,
      subIssuesComplete: true,
      blockersComplete: true,
    }),
});
const fixture = () => {
  const harness = makeHarness({
    issueServiceLayer: reads,
    providers: [
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-21T00:00:00Z",
        availability: "available",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
  });
  const dependencies = Layer.mergeAll(
    harness.layer,
    reads,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
  );
  return {
    harness,
    layer: dependencies.pipe(
      Layer.provideMerge(IssueWorkService.layer.pipe(Layer.provide(dependencies))),
    ),
  };
};
const createRoot = Effect.fn("test.createReadOnlyRoot")(function* (registered = true) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("read-only-root"),
    threadId: rootId,
    projectId,
    title: "Repository orchestrator",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    repositoryOrchestration: registered
      ? {
          ...DEFAULT_REPOSITORY_WORK_SETTINGS,
          ...reference,
          repositoryId: "repo:read-only",
          projectId,
          launchCommandId: CommandId.make("read-only-root"),
          revision: 1,
          paused: false,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
        }
      : undefined,
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("read-only-start"),
    threadId: rootId,
    messageId: MessageId.make("read-only-start"),
    text: "Investigate",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});
const delegate = Effect.fn("test.delegateReadOnly")(function* (
  number: number,
  parentThreadId = rootId,
  role: ThreadRole = "investigator",
  isolated = false,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const parent = (yield* threads.getThreadRecords(parentThreadId, ["runs"])).runs.at(-1)!;
  const result = yield* threads.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`read-only:${number}`),
    parentThreadId,
    parentRunId: parent.id,
    parentNodeId: parent.rootNodeId!,
    task: `Investigate ${number}`,
    role,
    ...(role === "implementor" ? { issue: issue(number) } : {}),
    ...(isolated
      ? {
          workspaceStrategy: {
            type: "worktree" as const,
            baseRef: "main",
            branch: "review-isolated",
          },
        }
      : {}),
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const event = result.storedEvents.find(
    (stored) => stored.event.type === "subagent.updated",
  )!.event;
  assert.equal(event.type, "subagent.updated");
  if (event.type !== "subagent.updated") return yield* Effect.die("Missing task");
  return event.payload.childThreadId!;
});
const lastRun = Effect.fn("test.lastRun")(function* (id: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return (yield* threads.getThreadRecords(id, ["runs"])).runs.at(-1)!;
});
const finish = Effect.fn("test.finishReadOnly")(function* (id: ThreadId) {
  const sink = yield* EventSink.EventSinkV2;
  const run = yield* lastRun(id);
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`finish:${run.id}`),
        type: "run.updated",
        threadId: id,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      },
    ],
  });
});

it.effect(
  "caps the whole lineage independently, queues FIFO, releases on completion, and validates both setters",
  () => {
    const { harness, layer } = fixture();
    return Effect.gen(function* () {
      yield* createRoot();
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const implementor = yield* delegate(100, rootId, "implementor");
      const first = yield* delegate(1, implementor, "reviewer");
      yield* delegate(2, first, "checker");
      yield* delegate(3);
      yield* delegate(4);
      const fifth = yield* delegate(5, first);
      const sixth = yield* delegate(6);
      assert.equal((yield* lastRun(fifth)).status, "queued");
      assert.equal((yield* lastRun(sixth)).status, "queued");
      const status = yield* service.repositoryStatus(reference);
      assert.equal(status.orchestration!.readOnlyLimit, 4);
      assert.equal(status.readOnlySlotsInUse, 4);
      assert.equal(status.slotsInUse, 1);
      assert.equal(harness.createWorktree.mock.calls.length, 0);
      assert.equal((yield* store.workerThreads(rootId)).length, 1);
      const threads = yield* ThreadManagement.ThreadManagementService;
      assert.isUndefined((yield* threads.getThreadShell(first))!.linkedIssue);
      const after = yield* sink.latestSequence();
      const promoted = yield* sink.stream({ afterSequence: after }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.threadId === fifth &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* finish(first);
      yield* Fiber.join(promoted);
      assert.equal((yield* lastRun(fifth)).status, "starting");
      assert.equal((yield* lastRun(sixth)).status, "queued");
      for (const invalid of [0, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
          (yield* service
            .setReadOnlyLimit({
              ...reference,
              readOnlyLimit: invalid,
              expectedRevision: 1,
              clientRequestId: CommandId.make(`invalid-read-only:${invalid}`),
            })
            .pipe(Effect.flip)).code,
          "invalid-request",
        );
      }
      assert.include(
        (yield* service
          .setReadOnlyLimit({
            ...reference,
            readOnlyLimit: 8,
            expectedRevision: 2,
            clientRequestId: CommandId.make("stale-read-only"),
          })
          .pipe(Effect.flip)).message,
        "Refresh",
      );
      const raised = yield* service.setReadOnlyLimit({
        ...reference,
        readOnlyLimit: 5,
        expectedRevision: 1,
        clientRequestId: CommandId.make("raise-read-only"),
      });
      assert.equal(raised.readOnlySlotsInUse, 5);
      assert.equal(raised.orchestration!.workerLimit, 4);
      assert.equal((yield* lastRun(sixth)).status, "starting");
      const lowered = yield* service.setReadOnlyLimit({
        ...reference,
        readOnlyLimit: 1,
        expectedRevision: 2,
        clientRequestId: CommandId.make("lower-read-only"),
      });
      assert.equal(lowered.readOnlySlotsInUse, 5);
      const seventh = yield* delegate(7);
      assert.equal((yield* lastRun(seventh)).status, "queued");
      const workerChanged = yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 1,
        expectedRevision: 3,
        clientRequestId: CommandId.make("independent-worker-limit"),
      });
      assert.equal(workerChanged.orchestration!.readOnlyLimit, 1);
      assert.equal(workerChanged.readOnlySlotsInUse, 5);
      assert.equal((yield* lastRun(seventh)).status, "queued");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "resumes at most four interrupted read-only children after restart, then admits the next continuation",
  () => {
    const { layer } = fixture();
    return Effect.gen(function* () {
      yield* createRoot();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      // Reproduce the pre-cap process with six running children.
      yield* service.setReadOnlyLimit({
        ...reference,
        readOnlyLimit: 6,
        expectedRevision: 1,
        clientRequestId: CommandId.make("pre-restart-limit"),
      });
      const children = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (number) => delegate(number));
      const runs = yield* Effect.forEach(children, lastRun);
      assert.isTrue(runs.every((run) => run.status === "starting"));
      yield* service.setReadOnlyLimit({
        ...reference,
        readOnlyLimit: 4,
        expectedRevision: 2,
        clientRequestId: CommandId.make("restart-limit"),
      });
      const now = yield* DateTime.now;
      // Startup recovery commits cancelled runs before dispatching their continuations.
      yield* sink.write({
        events: runs.map((run, index) => ({
          id: EventId.make(`restart:${run.id}`),
          type: "run.updated" as const,
          threadId: children[index]!,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "cancelled" as const, startedAt: now, completedAt: now },
        })),
      });
      yield* Effect.forEach(
        children,
        (threadId, index) =>
          threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`restart-message:${index}`),
            threadId,
            messageId: MessageId.make(`restart-message:${index}`),
            text: "Continue where you left off.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
            restartContinuationOfRunId: runs[index]!.id,
          }),
        { concurrency: "unbounded" },
      );
      const resumed = yield* Effect.forEach(children, lastRun);
      assert.equal(resumed.filter((run) => run.status === "starting").length, 4);
      assert.equal(resumed.filter((run) => run.status === "queued").length, 2);
      assert.equal((yield* service.repositoryStatus(reference)).readOnlySlotsInUse, 4);
      const firstRunning = children[resumed.findIndex((run) => run.status === "starting")]!;
      const queued = children[resumed.findIndex((run) => run.status === "queued")]!;
      const after = yield* sink.latestSequence();
      const promoted = yield* sink.stream({ afterSequence: after }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.threadId === queued &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* finish(firstRunning);
      yield* Fiber.join(promoted);
      assert.equal((yield* service.repositoryStatus(reference)).readOnlySlotsInUse, 4);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "MCP reports queued read-only children, keeps issue links claim-free, and sets either limit",
  () => {
    const { harness, layer } = fixture();
    const links: string[] = [];
    return Effect.gen(function* () {
      yield* createRoot();
      const service = yield* OrchestratorMcp.OrchestratorMcpService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const scope = {
        environmentId: EnvironmentId.make("read-only-limit"),
        requestNamespace: "read-only-limit",
        thread: {
          threadId: rootId,
          providerSessionId: "read-only-limit",
          providerInstanceId: modelSelection.instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 1,
      };
      for (const number of [1, 2, 3, 4, 5]) {
        const result = yield* service.delegateTask(scope, {
          task: `Review ${number}`,
          role: "reviewer",
          mode: "async",
          issue: { ...reference, number },
          clientRequestId: `mcp-read-only:${number}`,
        });
        assert.equal(result.status, number === 5 ? "queued" : "running");
        assert.isUndefined((yield* threads.getThreadShell(result.childThreadId!))!.linkedIssue);
      }
      assert.equal(links.length, 5);
      assert.equal(harness.createWorktree.mock.calls.length, 0);
      assert.equal((yield* store.workerThreads(rootId)).length, 0);
      const result = yield* service.setRepositoryWorkerLimit(scope, {
        ...reference,
        readOnlyLimit: 5,
        expectedRevision: 1,
        clientRequestId: CommandId.make("mcp-raise-read-only"),
      });
      assert.equal(result.readOnlySlotsInUse, 5);
      assert.equal(result.orchestration!.workerLimit, 4);
      const workers = yield* service.setRepositoryWorkerLimit(scope, {
        ...reference,
        workerLimit: 1,
        expectedRevision: 2,
        clientRequestId: CommandId.make("mcp-lower-workers"),
      });
      assert.equal(workers.orchestration!.readOnlyLimit, 5);
      for (const limits of [{}, { workerLimit: 1, readOnlyLimit: 1 }]) {
        const invalid = yield* service
          .setRepositoryWorkerLimit(scope, {
            ...reference,
            ...limits,
            expectedRevision: 3,
            clientRequestId: CommandId.make("mcp-invalid-limits"),
          })
          .pipe(Effect.flip);
        assert.include(invalid.message, "exactly one");
      }
    }).pipe(
      Effect.provide(
        OrchestratorMcp.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              layer,
              NodeCrypto.layer,
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(IssueLinks.IssueLinks)({
                link: (input) =>
                  Effect.sync(() => {
                    links.push(input.threadId!);
                    return {
                      issue: { ...reference, number: input.number! },
                      threadId: input.threadId!,
                      changed: true,
                    };
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect("prepares an explicitly isolated read-only child only after it gets a slot", () => {
  const { harness, layer } = fixture();
  return Effect.gen(function* () {
    yield* createRoot();
    const service = yield* IssueWorkService.IssueWorkService;
    const sink = yield* EventSink.EventSinkV2;
    yield* service.setReadOnlyLimit({
      ...reference,
      readOnlyLimit: 1,
      expectedRevision: 1,
      clientRequestId: CommandId.make("isolated-read-only-limit"),
    });
    const first = yield* delegate(1);
    const isolated = yield* delegate(2, rootId, "checker", true);
    assert.equal((yield* lastRun(isolated)).status, "queued");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    const after = yield* sink.latestSequence();
    const prepared = yield* sink.stream({ afterSequence: after }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.threadId === isolated &&
          stored.event.payload.status === "starting",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* finish(first);
    yield* Fiber.join(prepared);
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.equal((yield* service.repositoryStatus(reference)).readOnlySlotsInUse, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("pre-existing managers share repository read-only capacity after assignment", () => {
  const { layer } = fixture();
  return Effect.gen(function* () {
    yield* createRoot(false);
    const managerA = yield* delegate(100, rootId, "orchestrator");
    const managerB = yield* delegate(101, rootId, "orchestrator");
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "repository.work.restore",
      threadId: rootId,
      commandId: CommandId.make("register-existing-root"),
      expectedRootThreadId: null,
      expectedRevision: null,
      targetThreadId: rootId,
      projectId,
      ...reference,
      repositoryId: "repo:read-only",
      reason: "Assign existing lead",
    });
    yield* delegate(1);
    yield* delegate(2);
    yield* delegate(3);
    const sink = yield* EventSink.EventSinkV2;
    const commit = sink.commitCommand.bind(sink);
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    class HeldTestLock extends Context.Reference<ThreadId | null>("test/read-only-lock", {
      defaultValue: () => null,
    }) {}
    const withLock = locks.withLock.bind(locks);
    using _locks = vi
      .spyOn(locks, "withLock")
      .mockImplementation(<A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
        withLock(key, effect.pipe(Effect.provideService(HeldTestLock, key))),
      );
    let arrivals = 0;
    const release = yield* Deferred.make<void>();
    using _commit = vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
      Effect.gen(function* () {
        // Separate manager locks let both plans observe the last free slot before either commits.
        // A shared root lock prevents the second plan from reaching this gate.
        if (
          (input.commandId === "read-only:4" || input.commandId === "read-only:5") &&
          (yield* HeldTestLock) !== rootId
        ) {
          arrivals++;
          if (arrivals === 2) yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(release);
        }
        return yield* commit(input);
      }),
    );
    const children = yield* Effect.all([delegate(4, managerA), delegate(5, managerB)], {
      concurrency: "unbounded",
    });
    const service = yield* IssueWorkService.IssueWorkService;
    const status = yield* service.repositoryStatus(reference);
    assert.equal(status.readOnlySlotsInUse, 4);
    const runs = yield* Effect.forEach(children, lastRun);
    assert.sameMembers(
      runs.map((run) => run.status),
      ["starting", "queued"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "stopped read-only child with an agent follow-up cannot strand the repository queue",
  () => {
    const { layer } = fixture();
    return Effect.gen(function* () {
      yield* createRoot();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      yield* service.setReadOnlyLimit({
        ...reference,
        readOnlyLimit: 1,
        expectedRevision: 1,
        clientRequestId: CommandId.make("limit-one"),
      });
      const first = yield* delegate(1);
      const stopped = yield* delegate(2);
      yield* threads.dispatch({
        type: "thread.stop",
        threadId: stopped,
        commandId: CommandId.make("stop-queued"),
      });
      assert.equal((yield* lastRun(stopped)).queueHeld, true);
      yield* threads.sendToThread({
        projectId,
        threadId: stopped,
        senderThreadId: rootId,
        commandId: CommandId.make("agent-follow-up"),
        messageId: MessageId.make("agent-follow-up"),
        text: "Follow up when possible",
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const next = yield* delegate(3);
      yield* finish(first);
      // Explicit synchronous reconciliation avoids depending on event-consumer timing.
      yield* threads.dispatch({
        type: "repository.work.continue",
        threadId: rootId,
        commandId: CommandId.make("continue-after-finish"),
      });
      const occupancy = (yield* service.repositoryStatus(reference)).readOnlySlotsInUse;
      assert.equal(occupancy, 1);
      assert.equal((yield* lastRun(next)).status, "starting");
      const stoppedRuns = (yield* threads.getThreadRecords(stopped, ["runs"])).runs;
      assert.equal(stoppedRuns.length, 2);
      assert.isTrue(stoppedRuns.some((run) => run.queueHeld === true));
      assert.isTrue(stoppedRuns.every((run) => run.status === "queued"));
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a held manager command does not block a sibling without a repository orchestrator",
  () => {
    const { layer } = fixture();
    return Effect.gen(function* () {
      yield* createRoot(false);
      const managerA = yield* delegate(100, rootId, "orchestrator");
      const managerB = yield* delegate(101, rootId, "orchestrator");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const siblingBlocked = yield* Deferred.make<void>();
      const siblingComplete = yield* Deferred.make<void>();
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      class HeldTestLock extends Context.Reference<ThreadId | null>("test/unmanaged-lock", {
        defaultValue: () => null,
      }) {}
      let heldKey: ThreadId | null = null;
      const withLock = locks.withLock.bind(locks);
      using _locks = vi
        .spyOn(locks, "withLock")
        .mockImplementation(<A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            if (key === heldKey) yield* Deferred.succeed(siblingBlocked, undefined);
            return yield* withLock(key, effect.pipe(Effect.provideService(HeldTestLock, key)));
          }),
        );
      const commit = sink.commitCommand.bind(sink);
      using _commit = vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
        Effect.gen(function* () {
          if (input.commandId === "hold-manager") {
            heldKey = yield* HeldTestLock;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return yield* commit(input);
        }),
      );
      const held = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("hold-manager"),
          threadId: managerA,
          title: "Held manager",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const sibling = yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-sibling"),
          threadId: managerB,
          title: "Independent sibling",
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(siblingComplete, undefined)),
          Effect.forkChild,
        );
      yield* Effect.raceFirst(Deferred.await(siblingBlocked), Deferred.await(siblingComplete));
      assert.isTrue(yield* Deferred.isDone(siblingComplete));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(sibling);
      assert.equal((yield* threads.getThreadShell(managerB))?.title, "Independent sibling");
    }).pipe(Effect.provide(layer));
  },
);
