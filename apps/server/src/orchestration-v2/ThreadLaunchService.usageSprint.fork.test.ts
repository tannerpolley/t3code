import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type RepositoryOrchestration,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
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
const providers: ServerProvider[] = [
  {
    ...providerBase,
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00.000Z",
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt }],
    },
  },
  {
    ...providerBase,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
  },
];

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
  return { dependencies, rootId, createRoot, sprintMessages };
}

it.effect(
  "starts one sprint, stops it without interrupting, and ends the next at its reset with one message",
  () => {
    const { dependencies, rootId, createRoot, sprintMessages } = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const store = yield* IssueWorkStore.IssueWorkStore;
      yield* createRoot();
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
      const parent = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
      const delegate = (number: number) =>
        threads.dispatch({
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
      const latestRun = (threadId: ThreadId) =>
        threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.map(({ runs }) => runs.at(-1)!));
      const sprint = (providerInstanceId: ProviderInstanceId | null, request: string) =>
        service.setUsageSprint({
          ...reference,
          providerInstanceId,
          clientRequestId: CommandId.make(request),
        });

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

      yield* delegate(1);
      yield* worker.drain();
      const first = (yield* store.issueOwner(issue(1)))!;
      assert.equal((yield* latestRun(first)).status, "starting");
      const stopped = yield* sprint(null, "sprint-stop");
      yield* worker.drain();
      assert.isUndefined(stopped.orchestration!.usageSprint);
      assert.equal(stopped.orchestration!.usageSprintHistory?.at(-1)?.reason, "stopped");
      assert.equal((yield* latestRun(first)).status, "starting");
      assert.equal(yield* sprintMessages.pipe(Effect.map((messages) => messages.length)), 1);
      assert.isFalse(stopped.orchestration!.paused);

      yield* sprint(modelSelection.instanceId, "sprint-again");
      yield* delegate(2);
      yield* worker.drain();
      const second2 = (yield* store.issueOwner(issue(2)))!;
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          dependencies,
          IssueWorkService.layer.pipe(Layer.provide(dependencies)),
          suspensionWorkerLayer(dependencies),
        ),
      ),
    );
  },
);

it.effect("ends a sprint whose reset passed while the server was down on startup", () => {
  const { dependencies, rootId, createRoot, sprintMessages } = setup();
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
    assert.equal((yield* sprintMessages).length, 1);
  }).pipe(Effect.provide(dependencies));
});
