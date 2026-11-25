import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "./ThreadLaunchService.testHarness.ts";

const reference = { host: "github.com", repository: "owner/repo" };
const repositoryId = "repo:sprint";
function setup() {
  const reads = Layer.mock(IssueService.IssueService)({});
  const harness = makeHarness({ issueServiceLayer: reads });
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
          workerLimit: 4,
          readOnlyLimit: 4,
          publishStatusComments: false,
          publishCloseoutComments: false,
          suspendedIssues: [],
          ...orchestration,
        },
      });
    });
  return { dependencies, rootId, createRoot };
}

it.effect("retires a saved sprint on startup and preserves its history", () => {
  const { dependencies, rootId, createRoot } = setup();
  return Effect.gen(function* () {
    const sprint = {
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      windowId: "weekly",
      usedPercent: 40,
      resetsAt: "1970-01-08T00:00:00.000Z",
      startedAt: "1970-01-01T00:00:00.000Z",
    };
    const prior = {
      providerInstanceId: sprint.providerInstanceId,
      startedAt: "1969-12-24T00:00:00.000Z",
      endedAt: "1969-12-31T00:00:00.000Z",
      reason: "reset" as const,
      children: [],
    };
    yield* createRoot({ usageSprint: sprint, usageSprintHistory: [prior] });
    const childId = ThreadId.make("sprint-child");
    const threads = yield* ThreadManagement.ThreadManagementService;
    const root = (yield* threads.getThreadRecords(rootId, [])).thread;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("sprint-child-created"),
          type: "thread.created",
          threadId: childId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...root,
            id: childId,
            title: "Review in progress",
            repositoryOrchestration: undefined,
            role: "reviewer",
            lineage: {
              parentThreadId: rootId,
              rootThreadId: rootId,
              relationshipToParent: "subagent",
            },
            forkedFrom: { type: "node", nodeId: NodeId.make("sprint-review-task") },
          },
        },
      ],
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      threadId: childId,
      commandId: CommandId.make("sprint-child-review"),
      messageId: MessageId.make("sprint-child-review"),
      text: "Review the patch",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const activeRunId = (yield* threads.getThreadShell(childId))?.activeRunId;
    assert.isString(activeRunId);

    yield* Effect.service(IssueWorkService.IssueWorkService).pipe(
      Effect.provide(IssueWorkService.layer),
    );

    const store = yield* IssueWorkStore.IssueWorkStore;
    const config = yield* store.configuration(rootId);
    assert.isUndefined(config?.usageSprint);
    assert.deepEqual(config?.usageSprintHistory, [
      prior,
      {
        providerInstanceId: sprint.providerInstanceId,
        startedAt: sprint.startedAt,
        endedAt: sprint.startedAt,
        reason: "stopped",
        children: [{ threadId: childId }],
      },
    ]);
    const child = yield* threads.getThreadShell(childId);
    assert.equal(child?.activeRunId, activeRunId);
    assert.isUndefined(child?.explicitStopRequested);
  }).pipe(Effect.provide(dependencies));
});
