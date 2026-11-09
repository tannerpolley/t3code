import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type RepositoryOrchestration,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
  suspensionWorkerLayer,
} from "./ThreadLaunchService.testHarness.ts";

const reference = { host: "github.com", repository: "owner/repo" };
const repositoryId = "repo:sprint";
const issue = (number: number) => ({
  ...reference,
  repositoryId,
  id: `issue:${number}`,
  nodeId: `node:${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/owner/repo/issues/${number}`,
});
// The test clock starts at the epoch; the weekly window resets a week later.
const resetsAt = "1970-01-08T00:00:00.000Z";
const providerBase = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} as const;
const reporting = (usedPercent: number): ServerProvider[] => [
  {
    ...providerBase,
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00.000Z",
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent, resetsAt }],
    },
  },
  {
    ...providerBase,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
  },
];
const providers = reporting(40);

function setup() {
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
  const harness = makeHarness({ issueServiceLayer: reads, providers });
  const dependencies = Layer.mergeAll(
    harness.layer,
    reads,
    IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
    IdAllocator.layer,
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
  );
  const rootId = ThreadId.make("sprint-root");
  const createRoot = (orchestration: Partial<RepositoryOrchestration> = {}) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("sprint-root"),
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
        repositoryOrchestration: {
          ...reference,
          repositoryId,
          projectId,
          launchCommandId: CommandId.make("sprint-root"),
          revision: 1,
          paused: false,
          workerLimit: 4,
          readOnlyLimit: 4,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
          ...orchestration,
        },
      });
    });
  const sprintMessages = Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadProjection(rootId)).messages.filter((message) =>
      message.text.startsWith("The one-time usage sprint"),
    );
  });
  const startRoot = Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("sprint-root-start"),
      threadId: rootId,
      messageId: MessageId.make("sprint-root-start"),
      text: "Work on issues",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });
  const delegate = (number: number) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const parent = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(`sprint-delegate:${number}`),
        parentThreadId: rootId,
        parentRunId: parent.id,
        parentNodeId: parent.rootNodeId!,
        issue: issue(number),
        task: `Finish ${number}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      return (yield* (yield* IssueWorkStore.IssueWorkStore).issueOwner(issue(number)))!;
    });
  const latestRun = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return (yield* threads.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
    });
  const sprint = (providerInstanceId: ProviderInstanceId | null, request: string) =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      return yield* service.setUsageSprint({
        ...reference,
        providerInstanceId,
        clientRequestId: CommandId.make(request),
      });
    });
  // The service under test sees `override` in place of the harness's services.
  const layer = <A = never, E = never>(override?: Layer.Layer<A, E>) =>
    Layer.mergeAll(
      dependencies,
      IssueWorkService.layer.pipe(
        Layer.provide(
          override === undefined ? dependencies : Layer.mergeAll(dependencies, override),
        ),
      ),
      suspensionWorkerLayer(dependencies),
    );
  const registry =
    <E>(dependencies: Layer.Layer<ProviderRegistry.ProviderRegistry, E>) =>
    (getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>) =>
      Layer.effect(
        ProviderRegistry.ProviderRegistry,
        Effect.gen(function* () {
          const real = yield* ProviderRegistry.ProviderRegistry;
          return ProviderRegistry.ProviderRegistry.of({ ...real, getProviders });
        }),
      ).pipe(Layer.provide(dependencies));
  return {
    dependencies,
    rootId,
    createRoot,
    sprintMessages,
    startRoot,
    delegate,
    latestRun,
    sprint,
    layer,
    reportedBy: registry(dependencies),
  };
}

it.effect(
  "starts one sprint, stops it without interrupting, and ends the next at its reset with one message",
  () => {
    const { createRoot, sprintMessages, startRoot, delegate, latestRun, sprint, layer } = setup();
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createRoot();
      yield* startRoot;

      const noWindow = yield* sprint(providers[1]!.instanceId, "sprint-claude").pipe(Effect.flip);
      assert.include(noWindow.message, "no weekly usage window");
      const started = yield* sprint(modelSelection.instanceId, "sprint-codex");
      assert.deepInclude(started.orchestration!.usageSprint, {
        providerInstanceId: modelSelection.instanceId,
        windowId: "weekly",
        usedPercent: 40,
        resetsAt,
      });
      const second = yield* sprint(providers[1]!.instanceId, "sprint-second").pipe(Effect.flip);
      assert.include(second.message, "already running");

      const first = yield* delegate(1);
      assert.equal((yield* latestRun(first)).status, "starting");
      const stopped = yield* sprint(null, "sprint-stop");
      yield* worker.drain();
      assert.isUndefined(stopped.orchestration!.usageSprint);
      assert.equal(stopped.orchestration!.usageSprintHistory?.at(-1)?.reason, "stopped");
      assert.equal((yield* latestRun(first)).status, "starting");
      assert.equal(yield* sprintMessages.pipe(Effect.map((messages) => messages.length)), 1);
      assert.isFalse(stopped.orchestration!.paused);

      yield* sprint(modelSelection.instanceId, "sprint-again");
      const second2 = yield* delegate(2);
      yield* service.sweepUsageSprints;
      assert.isDefined((yield* service.repositoryStatus(reference)).orchestration!.usageSprint);

      yield* TestClock.adjust("7 days");
      yield* service.sweepUsageSprints;
      yield* worker.drain();
      const ended = (yield* service.repositoryStatus(reference)).orchestration!;
      assert.isUndefined(ended.usageSprint);
      assert.deepEqual(
        ended.usageSprintHistory?.map((entry) => entry.reason),
        ["stopped", "reset"],
      );
      assert.isFalse(ended.paused);
      for (const child of [first, second2])
        assert.notEqual((yield* latestRun(child)).status, "starting");
      const messages = yield* sprintMessages;
      assert.equal(messages.length, 2);
      assert.include(messages[1]!.text, "#1 Issue 1");
      assert.include(messages[1]!.text, "#2 Issue 2");
      assert.include(messages[1]!.text, "normal instructions and model roles");

      yield* service.sweepUsageSprints;
      assert.equal(yield* sprintMessages.pipe(Effect.map((all) => all.length)), 2);
    }).pipe(Effect.provide(layer()));
  },
);

it.effect("ends a sprint whose reset passed while the server was down on startup", () => {
  const { dependencies, rootId, createRoot } = setup();
  return Effect.gen(function* () {
    yield* TestClock.adjust("8 days");
    yield* createRoot({
      usageSprint: {
        providerInstanceId: modelSelection.instanceId,
        windowId: "weekly",
        usedPercent: 40,
        resetsAt,
        startedAt: "1970-01-01T00:00:00.000Z",
      },
    });
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    const cleared = yield* sink
      .stream({ threadId: rootId, afterSequence, eventType: "thread.metadata-updated" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.metadata-updated" &&
            event.payload.repositoryOrchestration?.usageSprint === undefined,
        ),
        Stream.runHead,
        // Constructing the service registers the sweep, which runs once at startup.
        Effect.provide(IssueWorkService.layer.pipe(Layer.provide(Scheduler.layer))),
      );
    assert.isTrue(Option.isSome(cleared));
    const history = (yield* (yield* IssueWorkStore.IssueWorkStore).configuration(rootId))
      ?.usageSprintHistory;
    assert.deepEqual(
      history?.map((entry) => entry.reason),
      ["reset"],
    );
  }).pipe(Effect.provide(dependencies));
});

it.effect("commits an end once and runs its stops and message once after a restart", () => {
  const {
    dependencies,
    rootId,
    createRoot,
    sprintMessages,
    startRoot,
    delegate,
    latestRun,
    sprint,
    layer,
  } = setup();
  return Effect.gen(function* () {
    const service = yield* IssueWorkService.IssueWorkService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* createRoot();
    yield* startRoot;
    yield* sprint(modelSelection.instanceId, "sprint");
    const children = [yield* delegate(1), yield* delegate(2)];
    const { startedAt } = (yield* service.repositoryStatus(reference)).orchestration!.usageSprint!;
    yield* TestClock.adjust("7 days");
    yield* service.sweepUsageSprints;

    // A late Stop finds no sprint, and the same end command replays its receipt.
    yield* sprint(null, "sprint-late-stop");
    const replay = yield* threads.dispatch({
      type: "repository.usage-sprint.end",
      commandId: CommandId.make(`usage-sprint-end:${rootId}:0:${startedAt}`),
      threadId: rootId,
      startedAt,
      reason: "stopped",
    });
    assert.isTrue(replay.replayed);
    const ended = (yield* service.repositoryStatus(reference)).orchestration!;
    assert.isUndefined(ended.usageSprint);
    assert.deepEqual(
      ended.usageSprintHistory?.map((entry) => [
        entry.reason,
        entry.children.map((child) => child.issue?.number),
      ]),
      [["reset", [1, 2]]],
    );

    // The process stopped after the commit, before the outbox ran; a restarted worker runs it.
    assert.lengthOf(yield* sprintMessages, 0);
    for (const child of children) assert.equal((yield* latestRun(child)).status, "starting");
    yield* Effect.gen(function* () {
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(suspensionWorkerLayer(dependencies)));
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const messages = yield* sprintMessages;
    assert.lengthOf(messages, 1);
    assert.include(messages[0]!.text, "stopped the running work of these issues");
    assert.include(messages[0]!.text, "#1 Issue 1; #2 Issue 2");
    for (const child of children) assert.notEqual((yield* latestRun(child)).status, "starting");
  }).pipe(Effect.provide(layer()));
});

it.effect("ends a sprint early when usage drops from its highest reading", () =>
  Effect.gen(function* () {
    const { createRoot, sprint, layer, reportedBy } = setup();
    let reported = providers;
    let loads = 0;
    const registry = reportedBy(Effect.sync(() => (loads++, reported)));
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const status = service
        .repositoryStatus(reference)
        .pipe(Effect.map((result) => result.orchestration!));
      yield* createRoot();
      yield* sprint(modelSelection.instanceId, "sprint");
      reported = reporting(70);
      yield* service.sweepUsageSprints;
      const peaked = yield* status;
      assert.equal(peaked.usageSprint?.usedPercent, 70);
      yield* service.sweepUsageSprints;
      assert.equal((yield* status).revision, peaked.revision);

      reported = reporting(50);
      yield* service.sweepUsageSprints;
      const ended = yield* status;
      assert.isUndefined(ended.usageSprint);
      assert.equal(ended.usageSprintHistory?.at(-1)?.reason, "early_reset");
      const before = loads;
      yield* service.sweepUsageSprints;
      assert.equal(loads, before);
    }).pipe(Effect.provide(layer(registry)));
  }),
);

it.effect("a sweep that read an old sprint leaves its replacement running", () =>
  Effect.gen(function* () {
    const { rootId, createRoot, sprint, layer, reportedBy } = setup();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let gated = false;
    // The gated read returns what the provider reported before its window reset early.
    const registry = reportedBy(
      Effect.suspend(() => {
        if (!gated) return Effect.succeed(providers);
        gated = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(providers),
        );
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createRoot();
      yield* sprint(modelSelection.instanceId, "sprint");
      gated = true;
      const sweep = yield* service.sweepUsageSprints.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const config = (yield* service.repositoryStatus(reference)).orchestration!;
      const replacementResetsAt = "1970-01-15T00:00:00.000Z";
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("sprint-replace"),
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          usageSprint: {
            ...config.usageSprint!,
            usedPercent: 0,
            resetsAt: replacementResetsAt,
            startedAt: "1970-01-01T00:00:01.000Z",
          },
        },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sweep);
      const after = (yield* service.repositoryStatus(reference)).orchestration!;
      assert.equal(after.usageSprint?.resetsAt, replacementResetsAt);
      assert.isUndefined(after.usageSprintHistory);
    }).pipe(Effect.provide(layer(registry)));
  }),
);

it.effect(
  "holds a lineage's turns on other providers: refuses sent follow-ups, queues automatic runs",
  () => {
    const { rootId, createRoot, startRoot, delegate, latestRun, sprint, layer } = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const sink = yield* EventSink.EventSinkV2;
      yield* createRoot();
      yield* startRoot;
      const child = yield* delegate(1);
      const parent = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
      const delegated = yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("sprint-read-only"),
        parentThreadId: rootId,
        parentRunId: parent.id,
        parentNodeId: parent.rootNodeId!,
        task: "Investigate",
        role: "investigator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const reader = delegated.storedEvents.flatMap(({ event }) =>
        event.type === "subagent.updated" && event.payload.childThreadId != null
          ? [event.payload.childThreadId]
          : [],
      )[0]!;
      const now = yield* DateTime.now;
      for (const threadId of [child, reader]) {
        const run = yield* latestRun(threadId);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`finish:${run.id}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
      }
      // A sprint on another provider than the child's, as if started before it was delegated.
      const config = (yield* service.repositoryStatus(reference)).orchestration!;
      yield* threads.dispatch({
        type: "repository.work.update",
        threadId: rootId,
        commandId: CommandId.make("sprint-claude"),
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          usageSprint: {
            providerInstanceId: providers[1]!.instanceId,
            windowId: "weekly",
            usedPercent: 0,
            resetsAt,
            startedAt: "1970-01-01T00:00:00.000Z",
          },
        },
      });

      const refused = yield* threads
        .sendToThread({
          projectId,
          threadId: child,
          senderThreadId: rootId,
          commandId: CommandId.make("sprint-follow-up"),
          messageId: MessageId.make("sprint-follow-up"),
          text: "One more thing",
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.flip);
      assert.include(String(refused), "usage sprint limits this repository's work");
      for (const threadId of [child, reader]) {
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`sprint-continuation:${threadId}`),
          threadId,
          messageId: MessageId.make(`sprint-continuation:${threadId}`),
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
        assert.equal((yield* latestRun(threadId)).status, "queued");
      }

      // Ending the sprint starts the read-only turn it held, and the issue worker's after its
      // issue read, with no separate continue.
      const held = yield* latestRun(child);
      const workerStarted = yield* sink
        .stream({ threadId: child, afterSequence: yield* sink.latestSequence() })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.id === held.id &&
              event.payload.status !== "queued",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
      yield* sprint(null, "sprint-stop");
      assert.equal((yield* latestRun(reader)).status, "starting");
      assert.isTrue(Option.isSome(yield* Fiber.join(workerStarted)));
      assert.equal((yield* latestRun(child)).status, "starting");
    }).pipe(Effect.provide(layer()));
  },
);
