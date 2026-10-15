import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as IssueService from "../issues/IssueService.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
  suspensionWorkerLayer,
} from "./ThreadLaunchService.testHarness.ts";

it.effect(
  "validates repository limits and revisions, admits queued workers on a raise, and only holds new starts on a lower",
  () => {
    const reference = { host: "github.com", repository: "owner/repo" };
    const issue = (number: number) => ({
      ...reference,
      repositoryId: "repo:limit",
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
    const harness = makeHarness({ issueServiceLayer: reads });
    const dependencies = Layer.mergeAll(
      harness.layer,
      reads,
      IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
      IdAllocator.layer,
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const rootId = ThreadId.make("limit-root");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("limit-root"),
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
          repositoryId: "repo:limit",
          projectId,
          launchCommandId: CommandId.make("limit-root"),
          revision: 1,
          paused: false,
          workerLimit: 1,
          publishStatusComments: false,
          publishCloseoutComments: false,
          milestones: [],
          suspendedIssues: [],
        },
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("limit-root-start"),
        threadId: rootId,
        messageId: MessageId.make("limit-root-start"),
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
          commandId: CommandId.make(`limit-delegate:${number}`),
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
      const store = yield* IssueWorkStore.IssueWorkStore;
      yield* delegate(1);
      yield* delegate(2);
      yield* worker.drain();
      const first = (yield* store.issueOwner(issue(1)))!;
      const held = (yield* store.issueOwner(issue(2)))!;
      const status = (id: ThreadId) =>
        threads
          .getThreadRecords(id, ["runs"])
          .pipe(Effect.map((records) => records.runs.at(-1)!.status));
      assert.equal(yield* status(first), "starting");
      assert.equal(yield* status(held), "queued");
      // The active root does not consume a worker slot; queued workers do not either.
      assert.equal((yield* service.repositoryStatus(reference)).slotsInUse, 1);
      for (const invalid of [0, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const error = yield* service
          .setWorkerLimit({
            ...reference,
            workerLimit: invalid,
            expectedRevision: 1,
            clientRequestId: CommandId.make(`invalid:${invalid}`),
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid-request");
      }
      assert.equal((yield* service.repositoryStatus(reference)).orchestration!.revision, 1);
      const stale = yield* service
        .setWorkerLimit({
          ...reference,
          workerLimit: 2,
          expectedRevision: 2,
          clientRequestId: CommandId.make("stale-limit"),
        })
        .pipe(Effect.flip);
      assert.include(stale.message, "Refresh");
      const raised = yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 2,
        expectedRevision: 1,
        clientRequestId: CommandId.make("raise-limit"),
      });
      yield* worker.drain();
      assert.equal(yield* status(held), "starting");
      assert.equal(raised.orchestration!.workerLimit, 2);
      assert.equal(raised.orchestration!.revision, 2);
      assert.equal(raised.slotsInUse, 2);
      const lowered = yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 1,
        expectedRevision: 2,
        clientRequestId: CommandId.make("lower-limit"),
      });
      yield* worker.drain();
      assert.equal(lowered.slotsInUse, 2);
      assert.equal(yield* status(first), "starting");
      assert.equal(yield* status(held), "starting");
      yield* delegate(3);
      yield* worker.drain();
      const third = (yield* store.issueOwner(issue(3)))!;
      assert.equal(yield* status(third), "queued");
      const paused = yield* service.setPaused({
        ...reference,
        paused: true,
        clientRequestId: CommandId.make("pause-limit"),
      });
      const max = yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 32,
        expectedRevision: paused.orchestration!.revision,
        clientRequestId: CommandId.make("max-limit"),
      });
      yield* worker.drain();
      assert.equal(max.orchestration!.workerLimit, 32);
      assert.equal(yield* status(third), "queued");
      const unchanged = yield* service.setWorkerLimit({
        ...reference,
        workerLimit: 32,
        expectedRevision: max.orchestration!.revision,
        clientRequestId: CommandId.make("same-limit"),
      });
      assert.equal(unchanged.orchestration!.revision, max.orchestration!.revision);
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
