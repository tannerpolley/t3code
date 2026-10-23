import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IssueReadError,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2Run,
  type ThreadRole,
} from "@t3tools/contracts";
import * as IssueInbox from "./IssueInbox.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { sourceMarker } from "./IssueInboxRules.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "./IssueService.ts";
import * as IssueWorkService from "./IssueWorkService.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "../orchestration-v2/ThreadLaunchService.testHarness.ts";

const reference = { host: "github.com", repository: "owner/repo" };
const issue = (number: number) => ({
  ...reference,
  repositoryId: "queue-repo",
  id: `issue:${number}`,
  nodeId: `node:${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/owner/repo/issues/${number}`,
});
const read = (number: number) => ({
  issue: issue(number),
  state: "open" as const,
  milestoneNumber: null,
  parent: null,
  subIssues: [],
  blockedBy: [],
  parentComplete: true,
  subIssuesComplete: true,
  blockersComplete: true,
});
const reads = Layer.mock(IssueService.IssueService)({
  resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
  detail: (input) =>
    Effect.succeed({
      issue: { ...issue(input.number), state: input.number === 99 ? "closed" : "open" },
    } as never),
  workRead: (input) => Effect.succeed(read(input.number)),
  repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: "queue-repo" }),
});
const projectRepositoryIdentity = {
  provider: "github" as const,
  canonicalKey: "github.com/owner/repo",
  displayName: "owner/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/owner/repo.git",
  },
};
function harness(issueReads = reads, candidateScan?: Deferred.Deferred<void>) {
  const base = makeHarness({
    issueServiceLayer: issueReads,
    projectRepositoryIdentity,
    localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
  });
  const dependencies = Layer.mergeAll(
    base.layer,
    issueReads,
    IssueWorkStore.layer.pipe(Layer.provide(base.layer)),
    ProjectionStore.layer.pipe(Layer.provide(base.layer)),
    IdAllocator.layer,
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
  );
  const executor = Layer.succeed(
    EffectWorker.OrchestrationEffectExecutorV2,
    EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
  );
  return Layer.mergeAll(
    ProjectionMaintenance.layer.pipe(
      Layer.provide(Layer.merge(dependencies, EventStore.layer.pipe(Layer.provide(dependencies)))),
    ),
    IssueWorkService.layer.pipe(
      Layer.provide(
        candidateScan === undefined
          ? Layer.empty
          : Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.map(ThreadManagement.ThreadManagementService, (threads) => ({
                ...threads,
                listProjectThreads: (input) =>
                  threads
                    .listProjectThreads(input)
                    .pipe(Effect.tap(() => Deferred.succeed(candidateScan, undefined))),
              })),
            ).pipe(Layer.provide(base.layer)),
      ),
      Layer.provide(dependencies),
    ),
    ProviderRuntimeRecovery.layer.pipe(Layer.provide(dependencies)),
    EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
      Layer.provide(Layer.mergeAll(dependencies, executor)),
    ),
  ).pipe(Layer.provideMerge(dependencies));
}
const rootId = ThreadId.make("queue-root");
const input = (number: number, key = `enqueue:${number}`) => ({
  ...reference,
  number,
  clientRequestId: CommandId.make(key),
});
const finish = (
  run: OrchestrationV2Run,
  key: string,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(key),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
  });

const assertQuietContinuation = (key: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    const sequence = yield* sink.latestSequence();
    const continued = yield* threads.dispatch({
      type: "repository.work.continue",
      threadId: rootId,
      commandId: CommandId.make(key),
    });
    yield* worker.drain();
    assert.deepEqual(continued.storedEvents, []);
    assert.equal(yield* sink.latestSequence(), sequence);
  });

it.effect("keeps root creation on the configured fallback when workers use All Claude", () => {
  const claude = {
    ...adapter,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
  };
  const adapters = [adapter, claude];
  const base = makeHarness({
    adapters,
    providers: adapters.map((entry): ServerProvider => ({
      instanceId: entry.instanceId,
      driver: entry.driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    })),
    issueServiceLayer: reads,
    projectRepositoryIdentity,
    localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
    serverSettings: {
      workerProvider: "claude",
      modelRoles: [
        {
          id: "worker",
          name: "Worker",
          description: "Issue worker",
          targets: [
            { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
            { providerInstanceId: claude.instanceId, model: "claude-sonnet-4-6" },
          ],
        },
      ],
    },
  });
  const dependencies = Layer.mergeAll(
    base.layer,
    reads,
    IssueWorkStore.layer.pipe(Layer.provide(base.layer)),
    IdAllocator.layer,
  );
  return Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const started = yield* service.start({
      ...input(1, "worker-provider:root"),
      projectId,
      modelRoleId: "worker",
      createOrchestrator: true,
    });
    assert.deepEqual(
      (yield* threads.getThreadRecords(started.rootThreadId, [])).thread.modelSelection,
      modelSelection,
    );
    assert.equal(
      (yield* store.latestRequest(issue(1)))!.modelSelection.instanceId,
      claude.instanceId,
    );
  }).pipe(Effect.provide(IssueWorkService.layer.pipe(Layer.provideMerge(dependencies))));
});

it.effect(
  "persists ordered requests without an orchestrator; enqueue, dequeue and retries are idempotent and separate from Start",
  () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(2));
      yield* service.queueIssue(input(1, "duplicate"));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2],
      );
      assert.isNull(yield* store.latestRequest(issue(1)));
      assert.isNull(yield* store.request(input(1).clientRequestId));
      yield* service.unqueueIssue(input(1, "remove"));
      yield* service.unqueueIssue(input(1, "remove"));
      yield* service.queueIssue(input(1));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
      yield* service.queueIssue(input(1, "again"));
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2, 1],
      );
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      assert.equal(
        (yield* service.queueIssue(input(99)).pipe(Effect.flip)).code,
        "invalid-request",
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "hands off one on availability, waits while paused, busy, full or handing off, and advances after the turn ends",
  () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(2));
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("queue-root-create"),
        threadId: rootId,
        projectId,
        title: "Queue orchestrator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        repositoryOrchestration: {
          ...reference,
          repositoryId: "queue-repo",
          projectId,
          launchCommandId: CommandId.make("queue-root-create"),
          revision: 1,
          paused: true,
          workerLimit: 1,
          readOnlyLimit: 4,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
        },
      });
      yield* worker.drain();
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 0);
      const initialConfig = (yield* service.repositoryStatus(reference)).orchestration!;
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("queue-handoff-request"),
        expectedRevision: initialConfig.revision,
        orchestration: {
          ...initialConfig,
          paused: false,
          handoff: {
            requestId: CommandId.make("queue-handoff"),
            nextThreadId: ThreadId.make("queue-next-root"),
            summary: "Continue queued work",
            modelSelection,
            status: "awaiting_approval",
            wasPaused: false,
          },
        },
      });
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        threadId: rootId,
        commandId: CommandId.make("pending-handoff"),
      });
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 0);
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("queue-handoff-cancel"),
        expectedRevision: initialConfig.revision + 1,
        orchestration: initialConfig,
      });
      const deliveryAfter = (afterSequence: number) =>
        sink.stream({ afterSequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "issue.queue.updated" &&
              stored.event.payload.noticeRunId !== undefined,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
      let sequence = yield* sink.latestSequence();
      yield* service.setPaused({
        ...reference,
        paused: false,
        clientRequestId: CommandId.make("resume-queue"),
      });
      yield* deliveryAfter(sequence);
      yield* worker.drain();
      const first = yield* threads.getThreadRecords(rootId, ["messages", "runs", "turnItems"]);
      assert.lengthOf(first.messages, 1);
      const notice = first.messages[0]!;
      assert.equal(notice.createdBy, "agent");
      assert.equal(notice.creationSource, "server");
      assert.include(
        notice.text,
        "Queued issue #1: Issue 1\nhttps://github.com/owner/repo/issues/1",
      );
      assert.include(notice.text, "Review this issue against the current code");
      assert.include(
        notice.text,
        'delegate_task with issue argument: {"host":"github.com","repository":"owner/repo","number":1}',
      );
      assert.deepEqual(notice.notification, {
        source: { kind: "system" },
        outcome: "updated",
        summary: "Queued issue #1 is next",
        detail: notice.text,
      });
      assert.lengthOf(first.runs, 1);
      assert.equal((yield* store.queue(reference))[0]!.noticeRunId, first.runs[0]!.id);
      assert.isTrue(yield* store.isQueueNoticeRun(rootId, first.runs[0]!.id));
      assert.deepEqual(
        first.turnItems.map((item) => item.type),
        ["notification"],
      );
      yield* service.queueIssue(input(3));
      yield* assertQuietContinuation("busy-root-continuation");
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2, 3],
      );
      sequence = yield* sink.latestSequence();
      yield* finish(first.runs[0]!, "queue-first-completed");
      yield* deliveryAfter(sequence);
      yield* worker.drain();
      const second = yield* threads.getThreadRecords(rootId, ["messages", "runs"]);
      assert.lengthOf(second.messages, 2);
      const activeRootRun = second.runs.at(-1)!;
      assert.include(
        second.messages.find((message) => message.runId === activeRootRun.id)!.text,
        "Queued issue #2: Issue 2",
      );
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2, 3],
      );
      yield* service.queueIssue(input(4));
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("queue-claim-worker"),
        parentThreadId: rootId,
        parentRunId: activeRootRun.id,
        parentNodeId: activeRootRun.rootNodeId!,
        issue: issue(4),
        task: "Implement issue 4",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* worker.drain();
      assert.equal(yield* store.slotsInUse(rootId), 1);
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2, 3],
      );
      assert.equal(
        (yield* service.queueIssue(input(4, "already-working")).pipe(Effect.flip)).code,
        "invalid-request",
      );
      yield* finish(activeRootRun, "queue-second-completed");
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        commandId: CommandId.make("full-pool"),
        threadId: rootId,
      });
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 2);
      yield* assertQuietContinuation("full-pool-continuation");
      sequence = yield* sink.latestSequence();
      const config = (yield* service.repositoryStatus(reference)).orchestration!;
      yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 2,
        expectedRevision: config.revision,
        clientRequestId: CommandId.make("raise-queue-limit"),
      });
      yield* deliveryAfter(sequence);
      yield* worker.drain();
      let root = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
      assert.lengthOf(root.messages, 3);
      assert.include(
        root.messages.find((message) => message.runId === root.runs.at(-1)!.id)!.text,
        "Queued issue #3: Issue 3",
      );
      yield* service.queueIssue(input(5));
      yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 1,
        expectedRevision: (yield* service.repositoryStatus(reference)).orchestration!.revision,
        clientRequestId: CommandId.make("lower-queue-limit"),
      });
      yield* finish(root.runs.at(-1)!, "queue-third-completed");
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        commandId: CommandId.make("pool-still-full"),
        threadId: rootId,
      });
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 3);
      const childId = (yield* store.issueOwner(issue(4)))!;
      const child = yield* threads.getThreadRecords(childId, ["runs"]);
      sequence = yield* sink.latestSequence();
      yield* finish(child.runs[0]!, "queue-worker-completed");
      yield* deliveryAfter(sequence);
      yield* worker.drain();
      root = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
      assert.lengthOf(root.messages, 4);
      assert.include(
        root.messages.find((message) => message.runId === root.runs.at(-1)!.id)!.text,
        "Queued issue #5: Issue 5",
      );
    }).pipe(Effect.provide(harness())),
);

const createRoot = (paused = true) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-root"),
      threadId: rootId,
      projectId,
      title: "Queue root",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      repositoryOrchestration: {
        ...reference,
        repositoryId: "queue-repo",
        projectId,
        launchCommandId: CommandId.make("create-root"),
        revision: 1,
        paused,
        workerLimit: 1,
        readOnlyLimit: 4,
        publishStatusComments: false,
        publishCloseoutComments: false,
        milestones: [],
        suspendedIssues: [],
      },
    });
  });

it.effect("replays the original mailbox receipt after an orchestrator is registered", () =>
  Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    yield* service.queueIssue(input(1));
    yield* createRoot();
    const result = yield* service.queueIssue(input(1));
    assert.equal(result.rootThreadId, rootId);
    assert.deepEqual(
      result.queue?.map((entry) => entry.issue.number),
      [1],
    );
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  }).pipe(Effect.provide(harness())),
);

it.effect.each([true, false])(
  "a continuation emits nothing during a draining handoff (queued: %s)",
  (queued) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot();
      if (queued) yield* service.queueIssue(input(1));
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: rootId,
        commandId: CommandId.make("hold-root-busy"),
        messageId: MessageId.make("hold-root-busy"),
        text: "Finish current orchestration",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const config = (yield* service.repositoryStatus(reference)).orchestration!;
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("waiting-handoff"),
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          handoff: {
            requestId: CommandId.make("handoff"),
            nextThreadId: ThreadId.make("next-root"),
            summary: "Wait for current work",
            modelSelection,
            status: "draining",
            wasPaused: false,
          },
        },
      });
      yield* worker.drain();
      const sequence = yield* sink.latestSequence();
      const result = yield* threads.dispatch({
        type: "repository.work.continue",
        threadId: rootId,
        commandId: CommandId.make("no-work-continue"),
      });
      yield* worker.drain();
      assert.lengthOf(result.storedEvents, 0);
      assert.equal(yield* sink.latestSequence(), sequence);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "refreshes the head and removes closed issues before delivering the next open issue",
  () => {
    const closed = new Set<number>();
    const refreshed = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) =>
        Effect.succeed({
          ...read(input.number),
          state: closed.has(input.number) ? ("closed" as const) : ("open" as const),
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      yield* createRoot();
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(2));
      closed.add(1);
      yield* service.setPaused({
        ...reference,
        paused: false,
        clientRequestId: CommandId.make("resume-closed-head"),
      });
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        threadId: rootId,
        commandId: CommandId.make("deliver-closed-head"),
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const records = yield* threads.getThreadRecords(rootId, ["messages"]);
      assert.lengthOf(records.messages, 1);
      assert.include(records.messages[0]!.text, "Queued issue #2:");
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
    }).pipe(Effect.provide(harness(refreshed)));
  },
);

const deliverFirst = Effect.gen(function* () {
  const service = yield* IssueWorkService.IssueWorkService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* service.queueIssue(input(1));
  yield* service.queueIssue(input(2));
  yield* createRoot();
  yield* service.setPaused({
    ...reference,
    paused: false,
    clientRequestId: CommandId.make("resume-delivery"),
  });
  yield* threads.dispatch({
    type: "issue.queue.deliver",
    threadId: rootId,
    commandId: CommandId.make("first-delivery"),
  });
  return (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
});

it.effect.each([false, true])(
  "closing a reviewed issue removes it when the notice finishes (worker pool full: %s)",
  (full) => {
    let closed = false;
    const completedReads: number[] = [];
    const refreshed = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) =>
        Effect.sync(() => {
          if (closed) completedReads.push(input.number);
          return {
            ...read(input.number),
            state: closed && input.number === 1 ? ("closed" as const) : ("open" as const),
          };
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const run = yield* deliverFirst;
      yield* service.unqueueIssue(input(2, "withdraw-second"));
      if (full)
        yield* service.startWorker({
          type: "delegated_task.request",
          commandId: CommandId.make("fill-worker-pool"),
          parentThreadId: rootId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          issue: issue(3),
          task: "Implement issue 3",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* worker.drain();
      assert.equal(yield* store.slotsInUse(rootId), full ? 1 : 0);
      closed = true;
      const sequence = yield* sink.latestSequence();
      yield* finish(run, "closed-during-review");
      yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "issue.queue.updated" &&
            stored.event.payload.issue.number === 1 &&
            stored.event.payload.state === "removed",
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      yield* worker.drain();
      assert.deepEqual(yield* store.queue(reference), []);
      assert.deepEqual(completedReads, [1]);
      yield* service.reconcile(rootId);
      yield* service.reconcile(rootId);
      assert.deepEqual(
        completedReads.filter((number) => number === 1),
        [1],
      );
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      assert.isTrue((yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid);
      assert.deepEqual(yield* store.queue(reference), []);
    }).pipe(Effect.provide(harness(refreshed)));
  },
);

it.effect("an open notice completion is read once and stays in attention", () =>
  Effect.gen(function* () {
    const readFinished = yield* Deferred.make<void>();
    let finishing = false;
    const completedReads: number[] = [];
    const issueReads = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) =>
        Effect.gen(function* () {
          if (finishing) {
            completedReads.push(input.number);
            yield* Deferred.succeed(readFinished, undefined);
          }
          return read(input.number);
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const run = yield* deliverFirst;
      yield* service.unqueueIssue(input(2, "withdraw-second"));
      yield* worker.drain();
      finishing = true;
      yield* finish(run, "open-review-completed");
      yield* Deferred.await(readFinished);
      yield* worker.drain();
      for (let pass = 0; pass < 3; pass++) yield* service.reconcile(rootId);
      assert.deepEqual(completedReads, [1]);
      assert.equal((yield* store.queue(reference))[0]!.state, "needs_attention");
    }).pipe(Effect.provide(harness(issueReads)));
  }),
);

it.effect(
  "a failed provider start returns the linked notice to the head without releasing another",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const run = yield* deliverFirst;
      const delivery = (yield* store.queue(reference))[0]!;
      assert.equal(delivery.noticeRunId, run.id);
      assert.isDefined(delivery.notifiedAt);
      assert.equal(delivery.state, "queued");
      // This is the terminal event committed by ProviderTurnStartService on startup failure.
      yield* finish(run, "provider-start-failed", "failed");
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const queue = yield* store.queue(reference);
      assert.deepEqual(
        queue.map((entry) => entry.issue.number),
        [1, 2],
      );
      assert.equal(queue[0]!.state, "queued");
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "restart recovery cancels an unstarted notice run and returns its issue to the head",
  () =>
    Effect.gen(function* () {
      const store = yield* IssueWorkStore.IssueWorkStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const run = yield* deliverFirst;
      const event = yield* (yield* EventSink.EventSinkV2).stream({}).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.created" && stored.event.payload.id === run.id,
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      const effects = yield* outbox.listByCommandId(event[0]!.commandId!);
      const start = effects.find((effect) => effect.request.type === "provider-turn.start")!;
      assert.equal(start.status, "pending");
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
      const recovered = yield* outbox.get(start.id);
      assert.isTrue(Option.isSome(recovered));
      assert.equal(Option.getOrThrow(recovered).status, "cancelled");
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2],
      );
      assert.isUndefined((yield* store.queue(reference))[0]!.noticeRunId);
      assert.equal(
        (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!.status,
        "cancelled",
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        threadId: rootId,
        commandId: CommandId.make("availability-after-recovery"),
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const messages = (yield* threads.getThreadRecords(rootId, ["messages"])).messages;
      assert.lengthOf(messages, 2);
      assert.include(messages[1]!.text, "Queued issue #1:");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "claiming a noticed issue clears it and repeated delegation returns the same worker",
  () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const run = yield* deliverFirst;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("claim-noticed-issue"),
        parentThreadId: rootId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        issue: issue(1),
        task: "Implement issue 1",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const first = yield* service.startWorker(command);
      const owner = yield* store.issueOwner(issue(1));
      assert.isNotNull(owner);
      const repeated = yield* service.startWorker({
        ...command,
        commandId: CommandId.make("claim-noticed-issue-again"),
      });
      assert.equal(yield* store.issueOwner(issue(1)), owner);
      assert.isTrue(first.storedEvents.some((stored) => stored.event.type === "thread.created"));
      assert.isFalse(
        repeated.storedEvents.some((stored) => stored.event.type === "thread.created"),
      );
      const task = repeated.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      )?.event;
      assert.equal(task?.type === "subagent.updated" ? task.payload.childThreadId : null, owner);
      yield* worker.drain();
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
      yield* finish(run, "claimed-notice-completed");
      yield* worker.drain();
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [2],
      );
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["subagents"])).subagents, 1);
    }).pipe(Effect.provide(harness())),
);

it.effect("completed notice needs attention, advances, and Retry reminds it again", () =>
  Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const run = yield* deliverFirst;
    yield* worker.drain();
    yield* finish(run, "unclaimed-completed");
    yield* threads.dispatch({
      type: "issue.queue.deliver",
      threadId: rootId,
      commandId: CommandId.make("next-notice"),
    });
    yield* worker.drain();
    let queue = yield* store.queue(reference);
    assert.equal(queue[0]!.state, "needs_attention");
    assert.isUndefined(queue[0]!.noticeRunId);
    assert.isDefined(queue[1]!.noticeRunId);
    assert.equal((yield* service.repositoryStatus(reference)).queue?.[0]!.state, "needs_attention");
    const second = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
    yield* finish(second, "second-completed");
    yield* worker.drain();
    yield* service.queueIssue(input(1, "retry-attention"));
    yield* worker.drain();
    queue = yield* store.queue(reference);
    assert.equal(queue[0]!.state, "queued");
    assert.isDefined(queue[0]!.noticeRunId);
    const records = yield* threads.getThreadRecords(rootId, ["messages", "runs"]);
    assert.lengthOf(records.messages, 3);
    const retriedRun = records.runs.find((run) => run.id === queue[0]!.noticeRunId)!;
    assert.include(
      records.messages.find((message) => message.id === retriedRun.userMessageId)!.text,
      "Queued issue #1:",
    );
    yield* service.unqueueIssue(input(1, "remove-active-notice"));
    assert.deepEqual(
      (yield* store.queue(reference)).map((entry) => entry.issue.number),
      [2],
    );
    yield* finish(retriedRun, "withdrawn-notice-completed");
    yield* worker.drain();
    assert.deepEqual(
      (yield* store.queue(reference)).map((entry) => entry.issue.number),
      [2],
    );
  }).pipe(Effect.provide(harness())),
);

it.effect.each(["failed", "cancelled", "interrupted"] as const)(
  "%s notice stays first and is reminded on the next availability",
  (status) =>
    Effect.gen(function* () {
      const store = yield* IssueWorkStore.IssueWorkStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const run = yield* deliverFirst;
      yield* worker.drain();
      yield* finish(run, `notice-${status}`, status);
      const providerThread = (yield* threads.getThreadRecords(rootId, ["providerThreads"]))
        .providerThreads[0]!;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make(`notice-${status}-provider-update`),
            type: "provider-thread.updated",
            threadId: rootId,
            runId: run.id,
            occurredAt: yield* DateTime.now,
            payload: { ...providerThread, status: "idle", pendingBackgroundTasks: [] },
          },
        ],
      });
      yield* worker.drain();
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [1, 2],
      );
      assert.isUndefined((yield* store.queue(reference))[0]!.noticeRunId);
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        threadId: rootId,
        commandId: CommandId.make("next-availability"),
      });
      yield* worker.drain();
      const messages = (yield* threads.getThreadRecords(rootId, ["messages"])).messages;
      assert.lengthOf(messages, 2);
      assert.include(messages[1]!.text, "Queued issue #1:");
    }).pipe(Effect.provide(harness())),
);

it.effect("periodic reconciliation delivers on an idle repository despite refresh failure", () => {
  let unavailable = false;
  let tick = Effect.void;
  const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
    name: string,
    work: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      if (name === "repository-issue-work")
        tick = work.pipe(Effect.provideContext(context), Effect.orDie);
    });
  const scheduler = Layer.succeed(Scheduler.Scheduler, { register });
  const issueReads = Layer.mock(IssueService.IssueService)({
    resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
    detail: (input) =>
      Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
    workRead: (input) =>
      unavailable
        ? Effect.fail(
            new IssueReadError({
              code: "rate-limited",
              operation: "detail",
              message: "Rate limited",
            }),
          )
        : Effect.succeed(read(input.number)),
  });
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const run = yield* deliverFirst;
    yield* worker.drain();
    unavailable = true;
    yield* finish(run, "notice-failed-before-reconcile", "failed");
    yield* worker.drain();
    assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
    assert.include(yield* (yield* IssueWorkStore.IssueWorkStore).activeRoots(), rootId);
    yield* tick;
    yield* worker.drain();
    const messages = (yield* threads.getThreadRecords(rootId, ["messages"])).messages;
    assert.lengthOf(messages, 2);
    assert.include(messages[1]!.text, "Queued issue #1:");
  }).pipe(Effect.provide(harness(issueReads).pipe(Layer.provide(scheduler))));
});

it.effect("reconciliation never reads the attention backlog while the root is busy or idle", () => {
  const refreshed: number[] = [];
  let tick = Effect.void;
  const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
    name: string,
    work: Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      if (name === "repository-issue-work")
        tick = work.pipe(Effect.provideContext(context), Effect.orDie);
    });
  const scheduler = Layer.succeed(Scheduler.Scheduler, { register });
  const issueReads = Layer.mock(IssueService.IssueService)({
    workRead: (input) =>
      Effect.sync(() => {
        refreshed.push(input.number);
        return read(input.number);
      }),
  });
  return Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const sink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* createRoot(false);
    yield* sink.write({
      events: Array.from({ length: 100 }, (_, index) => ({
        id: EventId.make(`attention:${index}`),
        type: "issue.queue.updated" as const,
        threadId: rootId,
        occurredAt: DateTime.makeUnsafe(0),
        payload: {
          requestId: CommandId.make(`attention:${index}`),
          issue: issue(index + 1),
          state: "needs_attention" as const,
        },
      })),
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      threadId: rootId,
      commandId: CommandId.make("busy-root"),
      messageId: MessageId.make("busy-root"),
      text: "Other work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    assert.isFalse(yield* store.queueRootIdle(rootId));
    for (let pass = 0; pass < 3; pass++) yield* service.reconcile(rootId);
    assert.deepEqual(refreshed, []);
    const run = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
    yield* finish(run, "other-work-completed");
    yield* worker.drain();
    assert.isTrue(yield* store.queueRootIdle(rootId));
    assert.notInclude(yield* store.activeRoots(), rootId);
    yield* tick;
    for (let pass = 0; pass < 3; pass++) yield* service.reconcile(rootId);
    assert.deepEqual(refreshed, []);
    assert.lengthOf(yield* store.queue(reference), 100);
  }).pipe(Effect.provide(harness(issueReads).pipe(Layer.provide(scheduler))));
});

it.effect.each(["external", "bot", "listing"] as const)(
  "inbox closes remove queued and attention entries through replayable queue commands (%s)",
  (origin) => {
    let closed = false;
    let listingCaughtUp = false;
    const github = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) => Effect.succeed(read(input.number)),
      repositoryRest: (input) =>
        Effect.succeed({
          status: 200,
          etag: null,
          nextPage: null,
          body: JSON.stringify(
            !closed
              ? []
              : input.path.startsWith("issues/events") && origin !== "listing"
                ? [
                    ...[1, 2].map((number) => ({
                      id: number,
                      event: "closed",
                      created_at: "1970-01-01T00:00:01Z",
                      actor: {
                        login: origin === "bot" ? "automation[bot]" : "owner",
                        type: origin === "bot" ? "Bot" : "User",
                      },
                      issue: { number, title: `Issue ${number}`, html_url: issue(number).url },
                    })),
                    ...["closed", "reopened"].map((event, index) => ({
                      id: index + 3,
                      event,
                      created_at: "1970-01-01T00:00:01Z",
                      actor: { login: "owner", type: "User" },
                      issue: { number: 3, title: "Issue 3", html_url: issue(3).url },
                    })),
                  ]
                : input.path.startsWith("issues?")
                  ? [1, 2, 3].map((number) => ({
                      ...issue(number),
                      state:
                        number === 3 && (origin === "listing" || listingCaughtUp)
                          ? "open"
                          : "closed",
                      html_url: issue(number).url,
                      created_at: "1969-12-31T23:59:00Z",
                      updated_at: "1970-01-01T00:00:00Z",
                    }))
                  : [],
          ),
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot(false);
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: rootId,
        commandId: CommandId.make("busy-root"),
        messageId: MessageId.make("busy-root"),
        text: "Other work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      for (const number of [1, 2, 3]) yield* service.queueIssue(input(number));
      const attention = (yield* store.queue(reference))[1]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("attention"),
            type: "issue.queue.updated",
            threadId: rootId,
            occurredAt: yield* DateTime.now,
            payload: { ...attention, state: "needs_attention" },
          },
        ],
      });
      const inbox = yield* IssueInbox.make;
      yield* inbox.pollDue;
      closed = true;
      yield* TestClock.adjust("5 minutes");
      yield* inbox.pollDue;
      yield* worker.drain();
      listingCaughtUp = true;
      assert.deepEqual(
        (yield* inbox.list(reference)).events
          .filter((event) => event.issueNumber <= 2)
          .map((event) => event.kind),
        [],
      );
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
      yield* TestClock.adjust("5 minutes");
      yield* inbox.pollDue;
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
      assert.isTrue((yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid);
      assert.deepEqual(
        (yield* store.queue(reference)).map((entry) => entry.issue.number),
        [3],
      );
    }).pipe(Effect.provide(harness(github)));
  },
);

it.effect.each([false, true])(
  "refreshes a new head when the previous candidate is claimed during refresh (failed refresh: %s)",
  (failedRefresh) => {
    const refreshed: number[] = [];
    let claimFirst: Effect.Effect<void> = Effect.void;
    const racingReads = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) =>
        Effect.gen(function* () {
          refreshed.push(input.number);
          if (input.number === 1) {
            yield* claimFirst;
            if (failedRefresh)
              return yield* new IssueReadError({
                code: "upstream",
                operation: "detail",
                message: "Refresh failed after claim.",
              });
          }
          return {
            ...read(input.number),
            state: input.number === 2 ? ("closed" as const) : ("open" as const),
          };
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      claimFirst = Effect.gen(function* () {
        claimFirst = Effect.void;
        yield* sink.write({
          events: [
            {
              id: EventId.make("claim-during-refresh"),
              type: "issue.work.requested",
              threadId: rootId,
              occurredAt: yield* DateTime.now,
              payload: {
                requestId: CommandId.make("claimed-first"),
                issue: issue(1),
                rootThreadId: rootId,
                issueThreadId: null,
                attemptKey: "claimed-first",
                modelSelection,
              },
            },
          ],
        });
      }).pipe(Effect.orDie);
      yield* createRoot();
      yield* service.queueIssue(input(1));
      yield* service.queueIssue(input(2));
      yield* service.setPaused({
        ...reference,
        paused: false,
        clientRequestId: CommandId.make("resume-race"),
      });
      yield* threads.dispatch({
        type: "issue.queue.deliver",
        threadId: rootId,
        commandId: CommandId.make("deliver-race"),
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.include(refreshed, 2);
      assert.deepEqual(yield* store.queue(reference), []);
      assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(harness(racingReads)));
  },
);

it.effect("rebuilds the same queue from notice, terminal, claim, retry and removal events", () =>
  Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const run = yield* deliverFirst;
    yield* worker.drain();
    const verify = Effect.gen(function* () {
      const before = yield* store.queue(reference);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* store.queue(reference), before);
    });
    yield* verify;
    yield* finish(run, "rebuild-failed-notice", "failed");
    yield* worker.drain();
    yield* verify;
    yield* threads.dispatch({
      type: "issue.queue.deliver",
      threadId: rootId,
      commandId: CommandId.make("rebuild-notice-again"),
    });
    yield* worker.drain();
    const next = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
    yield* finish(next, "rebuild-completed-notice");
    yield* worker.drain();
    yield* verify;
    yield* service.queueIssue(input(1, "rebuild-retry"));
    yield* worker.drain();
    const claim = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
    yield* service.startWorker({
      type: "delegated_task.request",
      commandId: CommandId.make("rebuild-claim"),
      parentThreadId: rootId,
      parentRunId: claim.id,
      parentNodeId: claim.rootNodeId!,
      issue: issue(1),
      task: "Implement issue 1",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* worker.drain();
    yield* service.queueIssue(input(3));
    yield* service.queueIssue(input(4));
    yield* service.unqueueIssue(input(4, "rebuild-remove"));
    yield* worker.drain();
    assert.deepEqual(
      (yield* store.queue(reference)).map((entry) => entry.issue.number),
      [2, 3],
    );
    yield* verify;
  }).pipe(Effect.provide(harness())),
);

const createCandidate = (id: string, role?: ThreadRole) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(id);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${id}:create`),
      threadId,
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (role !== undefined) {
      const sink = yield* EventSink.EventSinkV2;
      const thread = (yield* threads.getThreadRecords(threadId, [])).thread;
      yield* sink.write({
        events: [
          {
            type: "thread.metadata-updated",
            id: EventId.make(`${id}:role`),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, role },
          },
        ],
      });
    }
  });

it.effect.each([false, true])(
  "queue automatically registers the most recent Orchestrator exactly once under concurrency (no candidate: %s)",
  (noCandidate) =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      if (!noCandidate) {
        yield* createCandidate("older-orchestrator");
        yield* TestClock.adjust("1 second");
        yield* createCandidate("recent-orchestrator", "orchestrator");
      }
      yield* TestClock.adjust("1 second");
      yield* createCandidate("newest-implementor", "implementor");
      yield* TestClock.adjust("1 second");
      yield* createCandidate("archived-orchestrator");
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archived-orchestrator:archive"),
        threadId: ThreadId.make("archived-orchestrator"),
      });
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      const sink = yield* EventSink.EventSinkV2;
      const sequence = yield* sink.latestSequence();
      yield* Effect.all([service.queueIssue(input(1)), service.queueIssue(input(2))], {
        concurrency: 2,
      });
      if (!noCandidate)
        yield* sink.stream({ afterSequence: sequence }).pipe(
          Stream.filter((stored) => stored.event.type === "repository.work.restored"),
          Stream.take(1),
          Stream.runCollect,
        );
      assert.equal(
        (yield* service.repositoryStatus(reference)).rootThreadId,
        noCandidate ? null : "recent-orchestrator",
      );
      const registrations =
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`;
      assert.lengthOf(registrations, noCandidate ? 0 : 1);
      if (!noCandidate) {
        assert.isUndefined(
          (yield* threads.getThreadRecords(ThreadId.make("older-orchestrator"), [])).thread
            .repositoryOrchestration,
        );
        assert.equal((yield* service.queueIssue(input(1))).rootThreadId, "recent-orchestrator");
      }
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness())),
);

it.effect("does not register an orchestrator when replaying a withdrawn queue request", () =>
  Effect.gen(function* () {
    const candidateScan = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* service.queueIssue(input(1));
      yield* Deferred.await(candidateScan);
      yield* service.unqueueIssue(input(1, "withdraw-before-candidate"));
      yield* createCandidate("late-orchestrator");
      const replayed = yield* service.queueIssue(input(1));
      assert.isNull(replayed.rootThreadId);
      assert.deepEqual(replayed.queue, []);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        0,
      );
      const sequence = yield* sink.latestSequence();
      yield* service.queueIssue(input(1, "fresh-queue-transition"));
      yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter((stored) => stored.event.type === "repository.work.restored"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, "late-orchestrator");
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        1,
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness(reads, candidateScan)));
  }),
);

it.effect.each([false, true])(
  "queue and Inbox work register one root across mixed concurrent triggers (no candidate: %s)",
  (noCandidate) => {
    let arrived = false;
    const github = Layer.mock(IssueService.IssueService)({
      resolveLinkedIssue: (input) => Effect.succeed(issue(input.number)),
      detail: (input) =>
        Effect.succeed({ issue: { ...issue(input.number), state: "open" } } as never),
      workRead: (input) => Effect.succeed(read(input.number)),
      repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: "queue-repo" }),
      repositoryRest: (input) =>
        Effect.succeed({
          status: 200,
          etag: null,
          nextPage: null,
          body: JSON.stringify(
            arrived && input.path.startsWith("issues?")
              ? [
                  {
                    number: 7,
                    title: "External issue",
                    state: "open",
                    user: { login: "owner", type: "User" },
                    body: sourceMarker({
                      project: "other",
                      repository: "github.com/owner/other",
                      thread: "other-thread",
                    }),
                    created_at: "1970-01-01T00:00:01Z",
                    updated_at: "1970-01-01T00:00:01Z",
                    html_url: "https://github.com/owner/repo/issues/7",
                    labels: [],
                    milestone: null,
                  },
                ]
              : [],
          ),
        }),
    });
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const sql = yield* SqlClient.SqlClient;
      if (!noCandidate) yield* createCandidate("inbox-orchestrator");
      else yield* createCandidate("inbox-implementor", "implementor");
      const inbox = yield* IssueInbox.make;
      const concurrentInbox = yield* IssueInbox.make;
      yield* inbox.pollDue;
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      arrived = true;
      yield* TestClock.adjust("15 minutes");
      yield* Effect.all(
        [
          inbox.pollDue,
          concurrentInbox.pollDue,
          service.queueIssue(input(1)),
          service.queueIssue(input(2)),
        ],
        { concurrency: 4 },
      );
      assert.equal(
        (yield* service.repositoryStatus(reference)).rootThreadId,
        noCandidate ? null : "inbox-orchestrator",
      );
      assert.lengthOf((yield* inbox.list(reference)).events, 1);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`,
        noCandidate ? 0 : 1,
      );
      if (!noCandidate) {
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.lengthOf(
          (yield* threads.getThreadRecords(ThreadId.make("inbox-orchestrator"), ["messages"]))
            .messages,
          1,
        );
      }
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness(github)));
  },
);
