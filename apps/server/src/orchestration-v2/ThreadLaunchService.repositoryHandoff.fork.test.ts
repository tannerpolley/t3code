import * as Context from "effect/Context";
import * as Queue from "effect/Queue";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import { EventId } from "@t3tools/contracts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  adapter,
  decodeIssueCancellation,
  decodeIssueRequest,
  makeHarness,
  modelSelection,
  otherProjectId,
  projectId,
} from "./ThreadLaunchService.testHarness.ts";

describe("fresh-thread repository handoff", () => {
  const reference = { host: "github.com", repository: "tannerpolley/t3code" };
  const rootId = ThreadId.make("handoff-root");
  const linked = (number: number) => ({
    ...reference,
    repositoryId: "repo:handoff",
    id: `issue:${number}`,
    nodeId: `node:${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/tannerpolley/t3code/issues/${number}`,
  });
  const plan = {
    number: 1,
    modelRoleId: "worker",

    status: "running" as const,
    fingerprint: "",
  };
  const config = {
    ...reference,
    repositoryId: "repo:handoff",
    projectId,

    launchCommandId: CommandId.make("handoff-root-create"),
    revision: 1,
    paused: false,
    workerLimit: 4,
    readOnlyLimit: 4,
    publishStatusComments: true,
    publishCloseoutComments: true,
    milestones: [plan],
    suspendedIssues: [],
  };
  const summary = (number: number) => ({
    ...linked(number),
    state: "open" as const,
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    milestone: {
      number: 1,
      title: "First milestone",
      state: "open" as const,
      dueAt: null,
      url: "https://github.com/tannerpolley/t3code/milestone/1",
      openCount: 3,
      closedCount: 0,
    },
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    commentCount: 0,
  });
  const provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const fixture = (
    options: {
      git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
      recovery?: boolean;
      inventoryComplete?: () => boolean;
      providerAvailable?: () => boolean;
      continuation?: boolean;
      continuationRequests?: Context.Service.Shape<
        typeof ProviderContinuationRequests.ProviderContinuationRequests
      >;
      wrapThreads?: (
        threads: ThreadManagement.ThreadManagementService["Service"],
      ) => ThreadManagement.ThreadManagementService["Service"];
      inventoryIssues?: () => number[];
      /** Runs first in the provider check, which the handoff command makes under the root's lock. */
      beforeCapabilities?: () => Effect.Effect<
        void,
        ProviderAdapter.ProviderAdapterCapabilitiesError
      >;
      /** Wraps the store the issue work service reads. */
      wrapStore?: (
        store: IssueWorkStore.IssueWorkStore["Service"],
      ) => IssueWorkStore.IssueWorkStore["Service"];
    } = {},
  ) => {
    const reads = Layer.mock(IssueService.IssueService)({
      repositoryIdentity: () => Effect.succeed({ ...reference, repositoryId: config.repositoryId }),
      resolveLinkedIssue: (input) => Effect.succeed(linked(input.number)),
      detail: (input) =>
        Effect.succeed({
          repository: reference,
          viewer: null,
          fetchedAt: "2026-10-12T00:00:00Z",
          issue: summary(input.number),
          body: "Authorized issue",
          comments: [],
          linkedPullRequests: [],
        }),
      workRead: (input) =>
        Effect.succeed({
          issue: linked(input.number),
          state: "open" as const,
          milestoneNumber: 1,
          parent: input.number === 2 ? linked(1) : null,
          subIssues: input.number === 1 ? [linked(2)] : [],
          blockedBy: [],
          parentComplete: true,
          subIssuesComplete: true,
          blockersComplete: true,
        }),
      milestoneIssues: () =>
        Effect.succeed({
          issues: (options.inventoryIssues?.() ?? [1, 2, 9]).map(summary),
          complete: options.inventoryComplete?.() ?? true,
        }),
    });
    const handoffAdapter = {
      ...adapter,
      getCapabilities: () =>
        Effect.andThen(options.beforeCapabilities?.() ?? Effect.void, () =>
          options.providerAvailable?.() === false
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver: adapter.driver }),
              )
            : Effect.succeed(CodexProviderCapabilitiesV2),
        ),
    };
    const cursorAdapter = {
      ...handoffAdapter,
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
    };
    const harness = makeHarness({
      localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
      hasCommit: () => Effect.succeed(true),
      providers: [
        provider,
        { ...provider, instanceId: cursorAdapter.instanceId, driver: cursorAdapter.driver },
      ],
      ...(options.git === undefined ? {} : { git: options.git }),
      ...(options.recovery
        ? {
            projectRepositoryIdentity: {
              canonicalKey: "github.com/tannerpolley/t3code",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://github.com/tannerpolley/t3code.git",
              },
              provider: "github" as const,
              owner: "tannerpolley",
              name: "t3code",
              displayName: "tannerpolley/t3code",
            },
            serverSettings: {
              modelRoles: [
                {
                  id: "worker",
                  name: "Worker",
                  description: "Issue worker",
                  targets: [
                    { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
                  ],
                },
              ],
            },
          }
        : {}),
      adapters: [handoffAdapter, cursorAdapter],
      issueServiceLayer: reads,
      runContinuationWorker: options.continuation ?? false,
      ...(options.continuationRequests === undefined
        ? {}
        : { continuationRequests: options.continuationRequests }),
    });
    const store = IssueWorkStore.layer.pipe(Layer.provide(harness.layer));
    const dependencies = Layer.mergeAll(
      harness.layer,
      reads,
      NodeCrypto.layer,
      IdAllocator.layer,
      ProviderAdapterRegistry.layerFromAdapters([handoffAdapter, cursorAdapter]),
      store,
      EventStore.layer.pipe(Layer.provide(harness.layer)),
      ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      // Managed issue workers never read the caller's checkout commit.
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    );
    const { wrapStore } = options;
    const service = IssueWorkService.layer.pipe(
      Layer.provide(
        options.wrapThreads === undefined
          ? Layer.empty
          : Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.map(ThreadManagement.ThreadManagementService, options.wrapThreads),
            ).pipe(Layer.provide(harness.layer)),
      ),
      Layer.provide(
        wrapStore === undefined
          ? Layer.empty
          : Layer.effect(
              IssueWorkStore.IssueWorkStore,
              Effect.map(IssueWorkStore.IssueWorkStore, wrapStore),
            ).pipe(Layer.provide(store)),
      ),
      Layer.provideMerge(dependencies),
    );
    return Layer.mergeAll(
      service,
      OrchestratorMcp.layer.pipe(Layer.provide(service)),
      ProjectionMaintenance.layer.pipe(Layer.provide(dependencies)),
      ...(options.recovery
        ? [
            // Memoized: the same lock instance the orchestrator dispatches under.
            ThreadCommandExecutor.layer,
            EffectWorker.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
                    execute: () => Effect.void,
                  }),
                ),
              ),
            ),
          ]
        : []),
    );
  };
  const createRoot = Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: config.launchCommandId,
      threadId: rootId,
      projectId,
      title: "Repository orchestrator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      repositoryOrchestration: config,
      createdBy: "user",
      creationSource: "web",
    });
  });
  const scope = (threadId: ThreadId): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:handoff"),
    requestNamespace: "handoff",
    thread: {
      threadId,
      providerSessionId: "handoff-session",
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const finish = (threadId: ThreadId, key: string) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.findLast((entry) =>
        ["starting", "running", "waiting"].includes(entry.status),
      )!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${key}:result`),
            type: "message.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: MessageId.make(`${key}:result`),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              role: "assistant",
              text: `Finished ${key}. Evidence retained.`,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          },
          {
            id: EventId.make(`${key}:finish`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
    });
  const awaitFollowup = (threadId: ThreadId, afterSequence: number) =>
    EventSink.EventSinkV2.use((sink) =>
      sink.stream({ afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            (stored.event.type === "run.updated" || stored.event.type === "run.created") &&
            stored.event.threadId === threadId &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    );

  const originalLeadId = ThreadId.make("original-existing-lead");
  it.effect.each([{}, { isolation: "shared" }, { isolation: "worktree" }] as const)(
    "delegate_task starts an unstarted issue in the repository worktree regardless of caller isolation (%j)",
    (choice) => {
      const created: Array<
        Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0]
      > = [];
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRoot;
        yield* threads.dispatch({
          type: "repository.work.update",
          threadId: rootId,
          commandId: CommandId.make("worktree-policy"),
          expectedRevision: 1,
          orchestration: { ...config, milestones: [] },
        });
        yield* threads.sendToThread({
          projectId,
          threadId: rootId,
          commandId: CommandId.make("worktree-root-start"),
          messageId: MessageId.make("worktree-root-start"),
          text: "Orchestrate",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        const input = {
          task: "Implement the authorized issue",
          issue: { ...reference, number: 9 },
          target: { providerInstanceId: modelSelection.instanceId, model: modelSelection.model },
          ...choice,
          clientRequestId: "managed-worktree",
        };
        const task = yield* mcp.delegateTask(scope(rootId), input);
        yield* tracker.stream(task.childThreadId).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        assert.lengthOf(created, 1);
        assert.equal(created[0]!.refName, "trunk");
        assert.equal(created[0]!.newRefName, "issue-9-issue-9");
        assert.notEqual(created[0]!.newRefName, "trunk");
        assert.equal(yield* store.issueOwner(linked(9)), task.childThreadId);
        const child = yield* threads.getThreadRecords(task.childThreadId, ["runs"]);
        assert.equal(child.thread.lineage.parentThreadId, rootId);
        assert.equal(child.thread.worktreePath, `/worktrees/${created[0]!.newRefName}`);
        assert.equal(child.thread.branch, created[0]!.newRefName);
        assert.equal(child.runs[0]!.status, "starting");
        assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
        const duplicate = yield* mcp.delegateTask(scope(rootId), {
          ...input,
          clientRequestId: "managed-worktree-duplicate",
        });
        assert.equal(duplicate.childThreadId, task.childThreadId);
        const panelDuplicate = yield* service.start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",

          clientRequestId: CommandId.make("managed-panel-duplicate"),
        });
        assert.equal(panelDuplicate.issueThreadId, task.childThreadId);
        assert.lengthOf(created, 1);
        assert.lengthOf((yield* threads.getThreadRecords(rootId, ["subagents"])).subagents, 1);
        assert.lengthOf((yield* threads.getThreadRecords(rootId, ["messages"])).messages, 1);
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            git: {
              resolveDefaultBranchRef: () => Effect.succeed("trunk"),
              localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
              hasCommit: () => Effect.succeed(true),
              createWorktree: (input) =>
                Effect.sync(() => {
                  created.push(input);
                  return {
                    worktree: {
                      path: `/worktrees/${input.newRefName}`,
                      refName: input.newRefName!,
                      headSha: "abc",
                    },
                  };
                }),
            },
          }),
        ),
      );
    },
  );

  it.effect.each(["panel", "milestone"] as const)(
    "%s creates a worktree child without queuing the idle root, then delivers completion to it",
    (path) => {
      const created: Array<
        Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0]
      > = [];
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        yield* createRoot;
        yield* threads.dispatch({
          type: "repository.work.update",
          threadId: rootId,
          commandId: CommandId.make("shared-worktree-policy"),
          expectedRevision: 1,
          orchestration: { ...config, milestones: [] },
        });
        const input = {
          ...reference,
          projectId,
          modelRoleId: "worker",

          clientRequestId: CommandId.make(`shared-start:${path}`),
        };
        if (path === "panel") yield* service.start({ ...input, number: 9 });
        else yield* service.workMilestone({ ...input, milestoneNumber: 1 });
        const childId = (yield* store.issueOwner(linked(9)))!;
        yield* tracker.stream(childId).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        assert.lengthOf(created, 1);
        assert.equal(created[0]!.refName, "trunk");
        const child = yield* threads.getThreadRecords(childId, ["runs"]);
        assert.equal(child.thread.lineage.parentThreadId, rootId);
        assert.deepEqual(child.thread.modelSelection, modelSelection);
        assert.equal(child.thread.worktreePath, "/worktrees/issue-worker");
        assert.equal(child.runs[0]!.status, "starting");
        const root = yield* threads.getThreadRecords(rootId, ["messages", "runs", "subagents"]);
        assert.lengthOf(root.messages, 0);
        assert.lengthOf(root.runs, 0);
        assert.lengthOf(root.subagents, 1);
        if (path === "milestone")
          assert.equal(root.thread.repositoryOrchestration!.milestones[0]!.status, "running");
        const sink = yield* EventSink.EventSinkV2;
        const beforeCompletion = yield* sink.latestSequence();
        yield* finish(childId, `shared-start:${path}:done`);
        yield* (yield* Orchestrator.OrchestratorV2).recoverDelegatedTask(
          childId,
          child.runs[0]!.id,
        );
        yield* awaitFollowup(rootId, beforeCompletion);
        const notifiedRoot = yield* threads.getThreadRecords(rootId, [
          "messages",
          "runs",
          "subagents",
        ]);
        const completion = notifiedRoot.messages.find(
          (message) => message.delegatedCompletion !== undefined,
        )!;
        assert.equal(completion.delegatedCompletion!.parentRunId, null);
        assert.include(completion.text, notifiedRoot.subagents[0]!.id);
        assert.equal(notifiedRoot.subagents[0]!.completionDelivery?.state, "claimed");
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.deepEqual(
          (yield* threads.getThreadRecords(rootId, [])).thread.delegatedCompletion,
          notifiedRoot.thread.delegatedCompletion,
        );
        yield* threads.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`shared-start:${path}:ack`),
          parentThreadId: rootId,
          taskId: notifiedRoot.subagents[0]!.id,
          observedByRunId: null,
        });
        assert.deepEqual(
          (yield* threads.getThreadRecords(rootId, [])).thread.delegatedCompletion!.delivery!
            .taskIds,
          [],
        );
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            continuation: true,
            inventoryIssues: () => [9],
            git: {
              resolveDefaultBranchRef: () => Effect.succeed("trunk"),
              localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
              hasCommit: () => Effect.succeed(true),
              createWorktree: (input) =>
                Effect.sync(() => {
                  created.push(input);
                  return {
                    worktree: {
                      path: "/worktrees/issue-worker",
                      refName: input.newRefName!,
                      headSha: "abc",
                    },
                  };
                }),
            },
          }),
        ),
      );
    },
  );

  it.effect("serializes a panel sub-issue start with its parent's simultaneous delegate", () => {
    let gate: Deferred.Deferred<void> | undefined;
    let arrivals = 0;
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      yield* createRoot;
      const parent = (yield* service.start({
        ...reference,
        number: 1,
        projectId,
        modelRoleId: "worker",
        clientRequestId: CommandId.make("sub-race:parent"),
      })).issueThreadId!;
      yield* tracker.stream(parent).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      gate = yield* Deferred.make<void>();
      const results = yield* Effect.all(
        [
          service.start({
            ...reference,
            number: 2,
            projectId,
            modelRoleId: "worker",
            clientRequestId: CommandId.make("sub-race:panel"),
          }),
          (yield* OrchestratorMcp.OrchestratorMcpService).delegateTask(scope(parent), {
            issue: { ...reference, number: 2 },
            task: "Implement sub-issue 2",
            mode: "async",
            clientRequestId: "sub-race:delegate",
          }),
        ],
        { concurrency: 2 },
      );
      assert.equal(arrivals, 2);
      assert.equal(results[0].issueThreadId, results[1].childThreadId);
      assert.equal(yield* store.currentIssueOwner(linked(2)), results[1].childThreadId);
      const parentAfter = yield* threads.getThreadRecords(parent, ["subagents", "messages"]);
      assert.lengthOf(parentAfter.subagents, 1);
      assert.lengthOf(parentAfter.messages, 1);
    }).pipe(
      Effect.provide(
        fixture({
          recovery: true,
          git: {
            resolveDefaultBranchRef: () =>
              Effect.gen(function* () {
                const waiting = gate;
                if (waiting === undefined) return "main";
                arrivals++;
                if (arrivals === 2) yield* Deferred.succeed(waiting, undefined);
                yield* Deferred.await(waiting);
                return "main";
              }),
          },
        }),
      ),
    );
  });

  it.effect(
    "a permanently rejected sub-issue continuation still runs repository and milestone reconciliation",
    () => {
      let rejectNext = false;
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const sink = yield* EventSink.EventSinkV2;
        yield* createRoot;
        const parent = (yield* service.start({
          ...reference,
          number: 1,
          projectId,
          modelRoleId: "worker",
          clientRequestId: CommandId.make("continuation-failure:parent"),
        })).issueThreadId!;
        yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker).stream(parent).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        const now = yield* DateTime.now;
        const requestId = CommandId.make("continuation-failure:request");
        yield* sink.write({
          events: [
            {
              id: EventId.make("continuation-failure:pending"),
              type: "issue.work.requested",
              threadId: rootId,
              occurredAt: now,
              payload: {
                requestId,
                issue: linked(2),
                parent: linked(1),
                rootThreadId: rootId,
                issueThreadId: null,
                attemptKey: "first",
                modelSelection,
              },
            },
          ],
        });
        rejectNext = true;
        yield* service.reconcile(rootId);
        assert.isNull(yield* store.currentIssueOwner(linked(2)));
        assert.isNotNull(yield* store.currentIssueOwner(linked(9)));
        assert.equal((yield* store.configuration(rootId))!.milestones[0]!.status, "running");
        assert.isTrue(
          yield* threads.hasReceipt(CommandId.make(`issue-child-start:${requestId}:${parent}`)),
        );
        // The rejected receipt repeats on the next pass without stalling the rest of it.
        yield* service.reconcile(rootId);
        assert.isNotNull(yield* store.currentIssueOwner(linked(9)));
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            inventoryIssues: () => [9],
            beforeCapabilities: () =>
              rejectNext
                ? Effect.sync(() => {
                    rejectNext = false;
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ProviderAdapter.ProviderAdapterCapabilitiesError({
                          driver: adapter.driver,
                        }),
                      ),
                    ),
                  )
                : Effect.void,
          }),
        ),
      );
    },
  );

  it.effect(
    "rejects reusing a worker under a retired root without rewriting that root's task",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        yield* createRoot;
        const child = (yield* service.start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",
          clientRequestId: CommandId.make("foreign-reuse:first"),
        })).issueThreadId!;
        yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker).stream(child).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        const prior = yield* threads.getThreadRecords(rootId, ["subagents"]);
        const replacement = ThreadId.make("foreign-reuse:replacement");
        const now = yield* DateTime.now;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("foreign-reuse:create"),
          threadId: replacement,
          projectId,
          title: "Replacement repository orchestrator",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const target = (yield* threads.getThreadRecords(replacement, [])).thread;
        const successorConfig = {
          ...config,
          handoffHistory: [{ threadId: rootId, transferredAt: DateTime.formatIso(now) }],
          revision: 2,
          launchCommandId: CommandId.make("foreign-reuse:create"),
        };
        // A draining handoff retains active workers owned by the retiring root.
        yield* sink.write({
          events: [
            {
              id: EventId.make("foreign-reuse:restore"),
              type: "repository.work.restored",
              threadId: replacement,
              occurredAt: now,
              payload: {
                previousRootThreadId: rootId,
                targetThreadId: replacement,
                expectedRevision: 1,
                reason: "Retain the former root's running workers",
                repositoryOrchestration: successorConfig,
              },
            },
            {
              id: EventId.make("foreign-reuse:retire"),
              type: "thread.metadata-updated",
              threadId: rootId,
              occurredAt: now,
              payload: {
                ...prior.thread,
                repositoryOrchestration: { ...config, retiredToThreadId: replacement },
              },
            },
            {
              id: EventId.make("foreign-reuse:adopt"),
              type: "thread.metadata-updated",
              threadId: replacement,
              occurredAt: now,
              payload: { ...target, repositoryOrchestration: successorConfig },
            },
          ],
        });
        yield* threads.sendToThread({
          threadId: replacement,
          projectId,
          commandId: CommandId.make("foreign-reuse:run"),
          messageId: MessageId.make("foreign-reuse:run"),
          text: "Continue repository orchestration",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        const rejected = yield* (yield* OrchestratorMcp.OrchestratorMcpService)
          .delegateTask(scope(replacement), {
            issue: { ...reference, number: 9 },
            task: "Claim existing worker",
            mode: "async",
            clientRequestId: "foreign-reuse:delegate",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure") assert.include(rejected.failure.message, "another parent");
        assert.deepEqual(
          (yield* threads.getThreadRecords(rootId, ["subagents"])).subagents,
          prior.subagents,
        );
        assert.lengthOf((yield* threads.getThreadRecords(replacement, ["subagents"])).subagents, 0);
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "keeps invalid-request on rejected start replay so milestone reconciliation awaits the owner",
    () => {
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createRoot;
        const requestId = CommandId.make(`milestone-issue:${rootId}:1:issue:9:first`);
        yield* threads.dispatch({
          type: "repository.work.update",
          threadId: rootId,
          commandId: CommandId.make("reject-replay:pause"),
          expectedRevision: 1,
          orchestration: { ...config, paused: true },
        });
        const initial = yield* service
          .startWorker({
            type: "issue.work.start",
            commandId: requestId,
            threadId: rootId,
            issue: linked(9),
            workerModelSelection: modelSelection,
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.result);
        assert.equal(initial._tag, "Failure");
        if (initial._tag === "Failure")
          assert.equal(
            initial.failure._tag === "IssueWorkError" ? initial.failure.code : undefined,
            "invalid-request",
          );
        yield* threads.dispatch({
          type: "repository.work.update",
          threadId: rootId,
          commandId: CommandId.make("reject-replay:resume"),
          expectedRevision: 2,
          orchestration: { ...config, revision: 2, paused: false },
        });
        const replay = yield* service
          .start({
            ...reference,
            number: 9,
            projectId,
            modelRoleId: "worker",
            clientRequestId: requestId,
          })
          .pipe(Effect.result);
        assert.equal(replay._tag, "Failure");
        if (replay._tag === "Failure") assert.equal(replay.failure.code, "invalid-request");
        yield* service.reconcile(rootId);
        assert.equal(
          (yield* store.configuration(rootId))!.milestones[0]!.status,
          "awaiting_approval",
        );
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            inventoryIssues: () => [9],
          }),
        ),
      );
    },
  );

  it.effect(
    "recovers a committed runless completion after restart before its wake was sent",
    () => {
      let receiver:
        | Context.Service.Shape<typeof ProviderContinuationRequests.ProviderContinuationRequests>
        | undefined;
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* createRoot;
        const childId = (yield* service.start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",
          clientRequestId: CommandId.make("runless-recovery:start"),
        })).issueThreadId!;
        yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker).stream(childId).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        const childRun = (yield* threads.getThreadRecords(childId, ["runs"])).runs[0]!;
        yield* finish(childId, "runless-recovery:finished");
        yield* orchestrator.recoverDelegatedTask(childId, childRun.id);
        const committed = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
        assert.lengthOf(committed.runs, 0);
        assert.isNotNull(committed.thread.delegatedCompletion!.delivery);
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        // A fresh continuation consumer represents the process after restart.
        const queue =
          yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
        receiver = {
          offer: (request) => Queue.offer(queue, request).pipe(Effect.asVoid),
          take: Queue.take(queue),
        };
        yield* Layer.build(
          ProviderContinuationService.layer.pipe(
            Layer.provide(
              Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, receiver),
            ),
          ),
        );
        const before = yield* sink.latestSequence();
        yield* orchestrator.recoverDelegatedTasks;
        yield* awaitFollowup(rootId, before);
        const recovered = yield* threads.getThreadRecords(rootId, ["messages"]);
        assert.lengthOf(recovered.messages, 1);
        assert.deepEqual(
          recovered.messages[0]!.delegatedCompletion!.taskIds,
          committed.thread.delegatedCompletion!.delivery!.taskIds,
        );
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            continuationRequests: {
              offer: (request) => receiver?.offer(request) ?? Effect.void,
              take: Effect.never,
            },
          }),
        ),
      );
    },
  );

  it.effect.each(["root-stop", "wake-interrupt"] as const)(
    "%s drops current results without silencing a worker that finishes later",
    (stop) =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createRoot;
        const start = (number: number) =>
          service.start({
            ...reference,
            number,
            projectId,
            modelRoleId: "worker",
            clientRequestId: CommandId.make(`stop-mailbox:${number}`),
          });
        const first = (yield* start(9)).issueThreadId!;
        const later = (yield* start(10)).issueThreadId!;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        for (const childId of [first, later])
          yield* tracker.stream(childId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
        const beforeFirst = yield* sink.latestSequence();
        yield* finish(first, "stop-mailbox:first-finished");
        yield* orchestrator.recoverDelegatedTask(
          first,
          (yield* threads.getThreadRecords(first, ["runs"])).runs[0]!.id,
        );
        yield* awaitFollowup(rootId, beforeFirst);
        const wake = (yield* threads.getThreadRecords(rootId, ["runs"])).runs[0]!;
        if (stop === "root-stop")
          yield* threads.dispatch({
            type: "thread.stop",
            threadId: rootId,
            commandId: CommandId.make("stop-mailbox:stop"),
          });
        else
          yield* threads.dispatch({
            type: "run.interrupt",
            threadId: rootId,
            runId: wake.id,
            commandId: CommandId.make("stop-mailbox:interrupt"),
          });
        const stopped = yield* threads.getThreadRecords(rootId, ["subagents"]);
        assert.equal(
          stopped.subagents.find((task) => task.childThreadId === first)!.completionDelivery!.state,
          "disposed",
        );
        assert.isUndefined(
          stopped.subagents.find((task) => task.childThreadId === later)!.completionDelivery,
        );
        const beforeLater = yield* sink.latestSequence();
        yield* finish(later, "stop-mailbox:later-finished");
        yield* orchestrator.recoverDelegatedTask(
          later,
          (yield* threads.getThreadRecords(later, ["runs"])).runs[0]!.id,
        );
        yield* awaitFollowup(rootId, beforeLater);
        const notified = yield* threads.getThreadRecords(rootId, ["messages", "subagents"]);
        assert.lengthOf(notified.messages, 2);
        assert.equal(
          notified.subagents.find((task) => task.childThreadId === later)!.completionDelivery!
            .state,
          "claimed",
        );
      }).pipe(Effect.provide(fixture({ recovery: true, continuation: true }))),
  );

  it.effect(
    "uses the default branch for explicit roots and never gates worker admission on the root checkout",
    () => {
      let currentBranch = "master";
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const created = yield* service.start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",
          createOrchestrator: true,
          clientRequestId: CommandId.make("master-root:create"),
        });
        assert.equal(
          (yield* threads.getThreadRecords(created.rootThreadId, [])).thread.branch,
          "master",
        );
        currentBranch = "feature/owner-checkout";
        const worker = yield* service.start({
          ...reference,
          number: 10,
          projectId,
          modelRoleId: "worker",
          clientRequestId: CommandId.make("master-root:worker"),
        });
        assert.isNotNull(worker.issueThreadId);
        const rejected = yield* service
          .restoreRoot({
            ...reference,
            repositoryId: config.repositoryId,
            projectId,
            expectedRootThreadId: created.rootThreadId,
            expectedRevision: 1,
            targetThreadId: created.rootThreadId,
            reason: "Explicit restore",
            clientRequestId: CommandId.make("master-root:restore"),
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.include(rejected.failure.message, "default branch (master)");
      }).pipe(
        Effect.provide(
          fixture({
            recovery: true,
            git: {
              resolveDefaultBranchRef: () => Effect.succeed("master"),
              localStatus: () => Effect.succeed({ isRepo: true, refName: currentBranch } as never),
            },
          }),
        ),
      );
    },
  );

  it.effect("keeps internal dispatch failures unreadable during milestone reconciliation", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      yield* createRoot;
      const failed = yield* service
        .start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",
          clientRequestId: CommandId.make("store-failure:start"),
        })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.equal(failed.failure.code, "orchestration-error");
      yield* service.reconcile(rootId);
      assert.equal(
        (yield* service.repositoryStatus(reference)).orchestration!.milestones[0]!.status,
        "unreadable",
      );
    }).pipe(
      Effect.provide(
        fixture({
          recovery: true,
          inventoryIssues: () => [9],
          wrapThreads: (threads) => ({
            ...threads,
            dispatch: (command) =>
              command.type === "issue.work.start"
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: new Error("Issue work store is unavailable"),
                    }),
                  )
                : threads.dispatch(command),
          }),
        }),
      ),
    ),
  );

  const createOriginalLead = Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("original:create"),
      threadId: originalLeadId,
      projectId,
      title: "Original lead",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.sendToThread({
      projectId,
      threadId: originalLeadId,
      commandId: CommandId.make("original:start"),
      messageId: MessageId.make("original:start"),
      text: "Continue approved work",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* threads.getThreadRecords(originalLeadId, ["runs"])).runs.at(-1)!;
    const delegated = yield* threads.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("original:ordinary-child"),
      parentThreadId: originalLeadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Read-only issue diagnosis",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    return delegated.storedEvents.find((stored) => stored.event.type === "thread.created")!.event
      .threadId;
  });
  const createRecoveryRoot = Effect.gen(function* () {
    yield* createRoot;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "repository.work.update",
      threadId: rootId,
      commandId: CommandId.make("recovery:no-plan"),
      expectedRevision: 1,
      orchestration: { ...config, milestones: [] },
    });
  });
  const cancelInput = {
    ...reference,
    projectId,
    expectedRootThreadId: rootId,
    requestId: CommandId.make("wrong-root:issue-start"),
    reason: "Cancel accidental unclaimed start",
    clientRequestId: CommandId.make("wrong-root:cancel-request"),
  };
  const restoreInput = {
    ...reference,
    repositoryId: config.repositoryId,
    projectId,
    expectedRootThreadId: rootId,
    expectedRevision: 3,
    targetThreadId: originalLeadId,
    reason: "Restore the explicitly selected original lead",
    clientRequestId: CommandId.make("original:restore"),
  };
  const legacyRequest = (requestId: CommandId) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      return yield* sink.write({
        events: [
          {
            id: EventId.make(`${requestId}:event`),
            type: "issue.work.requested",
            threadId: rootId,
            occurredAt: now,
            payload: {
              requestId,
              issue: linked(9),
              parent: null,
              rootThreadId: rootId,
              issueThreadId: null,
              attemptKey: "first",
              modelSelection,
            },
          },
        ],
      });
    });
  const startWrongRoot = Effect.gen(function* () {
    yield* legacyRequest(cancelInput.requestId);
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.sendToThread({
      projectId,
      threadId: rootId,
      commandId: CommandId.make("legacy-root-start"),
      messageId: MessageId.make("legacy-root-start"),
      text: "Previously queued issue start",
      attachments: [],
      mode: "auto",
      createdBy: "user",
      creationSource: "web",
    });
  });

  it.effect(
    "standalone Start agent explicitly creates the first orchestrator once and reuses a registered owner",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const input = {
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",

          createOrchestrator: true,
        };
        const results = yield* Effect.all(
          [
            service.start({ ...input, clientRequestId: CommandId.make("explicit-create:first") }),
            service.start({
              ...input,
              clientRequestId: CommandId.make("explicit-create:concurrent"),
            }),
          ],
          { concurrency: 2 },
        );
        const owner = yield* store.repositoryOwner(config);
        assert.isNotNull(owner);
        assert.equal(results[0].rootThreadId, owner!.rootThreadId);
        assert.equal(results[1].rootThreadId, owner!.rootThreadId);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          2,
        );
        assert.lengthOf(
          (yield* threads.getThreadRecords(owner!.rootThreadId, ["runs", "messages"])).messages,
          0,
        );
        const childId = (yield* store.issueOwner(linked(9)))!;
        assert.equal(
          (yield* threads.getThreadRecords(childId, [])).thread.lineage.parentThreadId,
          owner!.rootThreadId,
        );
        const reused = yield* service.start({
          ...input,
          clientRequestId: CommandId.make("explicit-create:reuse-existing"),
        });
        assert.equal(reused.rootThreadId, owner!.rootThreadId);
        assert.isFalse(reused.createdRoot);
        assert.equal(
          (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          2,
        );
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "Start agent requires an explicit existing lead, registers it once and creates workers following the issue tree",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const ordinaryChild = yield* createOriginalLead;
        const ordinaryLineage = (yield* threads.getThreadRecords(ordinaryChild, [])).thread.lineage;
        const input = {
          ...reference,
          number: 2,
          projectId,
          modelRoleId: "worker",
        };
        const noSelection = yield* service
          .start({ ...input, clientRequestId: CommandId.make("start:unselected") })
          .pipe(Effect.result);
        assert.equal(noSelection._tag, "Failure");
        if (noSelection._tag === "Failure")
          assert.include(noSelection.failure.message, "Select an existing");
        assert.isNull(yield* store.repositoryOwner(config));
        assert.equal(
          (yield* service
            .restoreRoot({
              ...restoreInput,
              expectedRootThreadId: null,
              expectedRevision: null,
              repositoryId: "wrong-id",
              clientRequestId: CommandId.make("register:wrong-id"),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );

        const accepted = yield* service.start({
          ...input,
          orchestratorThreadId: originalLeadId,
          clientRequestId: CommandId.make("start:selected"),
        });
        assert.equal(accepted.rootThreadId, originalLeadId);
        assert.isFalse(accepted.createdRoot);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, originalLeadId);
        const parentWorker = (yield* store.issueOwner(linked(1)))!;
        const childWorker = (yield* store.issueOwner(linked(2)))!;
        assert.equal(
          (yield* threads.getThreadRecords(parentWorker, [])).thread.lineage.parentThreadId,
          originalLeadId,
        );
        const child = (yield* threads.getThreadRecords(childWorker, [])).thread;
        assert.equal(child.lineage.parentThreadId, parentWorker);
        assert.equal(child.lineage.rootThreadId, originalLeadId);
        assert.equal(child.linkedIssue!.id, linked(2).id);
        assert.deepEqual(
          (yield* threads.getThreadRecords(ordinaryChild, [])).thread.lineage,
          ordinaryLineage,
        );
        assert.equal((yield* service.workStatus(input)).threadId, childWorker);
        // Registered ownership remains authoritative for standalone requests without a thread origin.
        assert.equal(
          (yield* service.start({
            ...input,
            number: 9,
            clientRequestId: CommandId.make("start:registered"),
          })).rootThreadId,
          originalLeadId,
        );
        assert.equal(
          (yield* service
            .start({
              ...input,
              orchestratorThreadId: ordinaryChild,
              clientRequestId: CommandId.make("start:conflicting-selection"),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          5,
        );
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* store.repositoryOwner(config))!.rootThreadId, originalLeadId);
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "cancels a stopped paused root request, restores the existing lead and child, archives normally, and starts through that lead",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const sink = yield* EventSink.EventSinkV2;
        const childId = yield* createOriginalLead;
        const childBefore = yield* threads.getThreadRecords(childId, ["runs"]);
        assert.isUndefined(
          (yield* threads.getThreadRecords(originalLeadId, [])).thread.repositoryOrchestration,
        );
        // A historical explicit issue claim under the original lead must survive adoption too.
        yield* sink.write({
          events: [
            {
              id: EventId.make("original:retained-claim"),
              type: "thread.created",
              threadId: childId,
              occurredAt: yield* DateTime.now,
              payload: { ...childBefore.thread, linkedIssue: linked(1) },
            },
          ],
        });
        yield* createRecoveryRoot;
        yield* startWrongRoot;
        yield* legacyRequest(CommandId.make("wrong-root:duplicate-start"));
        yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("wrong:pause"),
        });
        yield* threads.dispatch({
          type: "run.interrupt",
          threadId: rootId,
          runId: (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!.id,
          commandId: CommandId.make("wrong:stop"),
        });
        yield* worker.drain();
        yield* threads.dispatch({
          type: "thread.settle",
          threadId: rootId,
          commandId: CommandId.make("wrong:settle"),
        });
        const stopped = yield* threads.getThreadShell(rootId);
        assert.isNull(stopped!.activeRunId);
        assert.isNotNull(stopped!.settledAt);
        assert.isTrue(yield* store.hasUnclaimedRequests(rootId));
        const archive = (key: string) =>
          threads.dispatch({
            type: "thread.archive",
            threadId: rootId,
            commandId: CommandId.make(key),
          });
        const blocked = yield* archive("wrong:blocked-archive").pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
        if (blocked._tag === "Failure") {
          assert.include(blocked.failure.message, "unclaimed issue start requests");
          assert.notInclude(blocked.failure.message, "pending handoff");
        }
        // The newest coalesced request; cancelling it releases the whole attempt.
        assert.equal(
          (yield* service.workStatus({ ...reference, number: 9 })).pendingRequestId,
          CommandId.make("wrong-root:duplicate-start"),
        );
        const cancelled = yield* service.cancelRequest(cancelInput);
        assert.deepEqual(
          cancelled.cancellation,
          (yield* service.cancelRequest(cancelInput)).cancellation,
        );
        assert.equal(cancelled.cancellation!.commandId, cancelInput.clientRequestId);
        assert.equal(
          (yield* service
            .cancelRequest({
              ...cancelInput,
              requestId: CommandId.make("wrong-root:duplicate-start"),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );

        assert.equal(cancelled.rootThreadId, rootId);
        assert.isFalse(yield* store.hasUnclaimedRequests(rootId));
        assert.isFalse(yield* store.hasAttempt(linked(9), "first"));
        assert.lengthOf(yield* store.pendingRequests(rootId), 0);
        assert.notInclude(yield* store.activeRoots(), rootId);
        assert.notInclude(
          (yield* store.recoveryInventory(config)).map((row) => row.detail).join("\n"),
          "#9",
        );
        const afterCancel = yield* service.workStatus({ ...reference, number: 9 });
        assert.equal(afterCancel.status, "cancelled");
        assert.isNull(afterCancel.pendingRequestId);
        assert.equal(
          (yield* service.start({
            ...reference,
            number: 9,
            projectId,
            modelRoleId: "worker",

            clientRequestId: cancelInput.requestId,
          })).status,
          "cancelled",
        );
        yield* archive("wrong:archive-after-cancel");
        yield* threads.dispatch({
          type: "thread.unarchive",
          threadId: rootId,
          commandId: CommandId.make("wrong:unarchive-for-restore"),
        });
        const restored = yield* service.restoreRoot(restoreInput);
        assert.equal(restored.rootThreadId, originalLeadId);
        assert.isTrue(restored.orchestration!.paused);
        assert.equal(restored.orchestration!.revision, 4);
        assert.equal((yield* service.restoreRoot(restoreInput)).rootThreadId, originalLeadId);
        assert.equal(
          (yield* service
            .restoreRoot({ ...restoreInput, targetThreadId: childId })
            .pipe(Effect.result))._tag,
          "Failure",
        );

        assert.equal((yield* store.configuration(rootId))!.retiredToThreadId, originalLeadId);
        assert.equal(yield* store.issueOwner(linked(1)), childId);
        assert.equal(yield* store.currentIssueOwner(linked(1)), childId);
        const childAfter = yield* threads.getThreadRecords(childId, ["runs"]);
        assert.deepEqual(childAfter.thread.lineage, childBefore.thread.lineage);
        assert.deepEqual(childAfter.runs, childBefore.runs);
        assert.equal(childAfter.thread.lineage.parentThreadId, originalLeadId);
        yield* archive("wrong:final-archive");
        assert.isNotNull((yield* threads.getThreadShell(rootId))!.archivedAt);
        yield* service.setPaused({
          ...reference,
          paused: false,
          clientRequestId: CommandId.make("original:resume"),
        });
        const started = yield* service.start({
          ...reference,
          number: 9,
          projectId,
          modelRoleId: "worker",

          clientRequestId: CommandId.make("original:subsequent-start"),
        });
        assert.equal(started.rootThreadId, originalLeadId);
        assert.isFalse(started.createdRoot);
        assert.isTrue(yield* store.hasAttempt(linked(9), "first"));
        assert.lengthOf(yield* store.pendingRequests(originalLeadId), 0);
        assert.equal(
          (yield* store.request(CommandId.make("original:subsequent-start")))!.issueThreadId,
          started.issueThreadId,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          4,
        );
        const audit = yield* sql<{
          event_type: string;
          payload_json: string;
        }>`SELECT event_type, payload_json FROM orchestration_events WHERE event_type IN ('issue.work.requested', 'issue.work.cancelled', 'repository.work.restored') ORDER BY sequence`;
        assert.deepEqual(
          audit.map((event) => event.event_type),
          [
            "issue.work.requested",
            "issue.work.requested",
            "issue.work.cancelled",
            "issue.work.cancelled",
            "repository.work.restored",
            "issue.work.requested",
          ],
        );
        const originalRequest = yield* decodeIssueRequest(audit[0]!.payload_json);
        const cancellation = yield* decodeIssueCancellation(audit[2]!.payload_json);
        assert.isUndefined(originalRequest.cancellation);
        assert.equal(cancellation.cancellation.reason, cancelInput.reason);
        assert.equal(cancellation.requestedRequestId, cancelInput.requestId);
        assert.isDefined(
          (yield* store.request(CommandId.make("wrong-root:duplicate-start")))!.cancellation,
        );
        yield* worker.drain();
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, originalLeadId);
        assert.equal((yield* store.request(cancelInput.requestId))!.rootThreadId, rootId);
        assert.equal(
          (yield* store.request(cancelInput.requestId))!.cancellation!.reason,
          cancelInput.reason,
        );
        assert.equal(yield* store.currentIssueOwner(linked(1)), childId);
        assert.deepEqual(
          (yield* threads.getThreadRecords(childId, [])).thread.lineage,
          childBefore.thread.lineage,
        );
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "serializes unclaimed cancellation against claiming without interrupting the winner's worker",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* IssueWorkService.IssueWorkService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRecoveryRoot;
        yield* startWrongRoot;
        const run = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
        const results = yield* Effect.all(
          [
            threads
              .dispatch({
                type: "delegated_task.request",
                commandId: CommandId.make("race:claim"),
                parentThreadId: rootId,
                parentRunId: run.id,
                parentNodeId: run.rootNodeId!,
                issue: linked(9),
                task: "Authorized issue worker",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.result),
            service.cancelRequest(cancelInput).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        if (results[0]._tag === "Success") {
          const owner = yield* store.issueOwner(linked(9));
          assert.isNotNull(owner);
          assert.equal(
            (yield* threads.getThreadRecords(owner!, ["runs"])).runs.at(-1)!.status,
            "starting",
          );
          assert.isUndefined((yield* store.request(cancelInput.requestId))!.cancellation);
          const retryCancel = yield* service
            .cancelRequest({ ...cancelInput, clientRequestId: CommandId.make("claimed:cancel") })
            .pipe(Effect.result);
          assert.equal(retryCancel._tag, "Failure");
          if (retryCancel._tag === "Failure")
            assert.include(retryCancel.failure.message, "unclaimed");
        } else {
          assert.isNull(yield* store.issueOwner(linked(9)));
          assert.isFalse(yield* store.hasAttempt(linked(9), "first"));
        }
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  const createLead = (threadId: ThreadId) =>
    ThreadManagement.ThreadManagementService.use((threads) =>
      threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Existing lead",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      }),
    );
  it.effect(
    "assigns an existing thread once and moves to another existing thread through a draining handoff",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const target = ThreadId.make("assigned-lead");
        const successor = ThreadId.make("assigned-successor");
        yield* createLead(target);
        yield* createLead(successor);
        const assign = {
          ...reference,
          projectId,
          targetThreadId: target,
          clientRequestId: CommandId.make("assign:first"),
        };
        assert.equal((yield* service.assignOrchestrator(assign)).rootThreadId, target);
        assert.equal((yield* service.assignOrchestrator(assign)).rootThreadId, target);
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("assign:running"),
          threadId: target,
          messageId: MessageId.make("assign:running"),
          text: "Work in progress",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const move = {
          ...assign,
          targetThreadId: successor,
          clientRequestId: CommandId.make("assign:move"),
        };
        const pending = yield* service.assignOrchestrator(move);
        assert.equal(pending.rootThreadId, target);
        assert.equal(pending.orchestration!.handoff?.status, "draining");
        assert.equal(pending.orchestration!.handoff?.nextThreadId, successor);
        assert.equal((yield* service.assignOrchestrator(move)).rootThreadId, target);
        yield* finish(target, "assign:finished");
        yield* service.reconcile(target);
        yield* worker.drain();
        const moved = yield* service.repositoryStatus(reference);
        assert.equal(moved.rootThreadId, successor);
        assert.deepEqual(
          moved.orchestration!.handoffHistory?.map((entry) => entry.threadId),
          [target],
        );
        const messages = (yield* threads.getThreadRecords(successor, ["messages"])).messages;
        assert.lengthOf(messages, 1);
        assert.include(messages[0]!.text, "Server recovery inventory");
        assert.equal((yield* service.assignOrchestrator(move)).rootThreadId, successor);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          2,
        );
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'repository.work.restored'`)
            .length,
          1,
        );
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "rejects Implementors at assignment and revalidates the role after handoff draining",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const target = ThreadId.make("role-checked-successor");
        yield* createLead(target);
        const setRole = (role: "implementor" | "orchestrator", key: string) =>
          Effect.gen(function* () {
            const thread = (yield* threads.getThreadRecords(target, [])).thread;
            yield* sink.write({
              events: [
                {
                  type: "thread.metadata-updated",
                  id: EventId.make(key),
                  threadId: target,
                  occurredAt: yield* DateTime.now,
                  payload: { ...thread, role },
                },
              ],
            });
          });
        const input = {
          ...reference,
          projectId,
          targetThreadId: target,
          clientRequestId: CommandId.make("role:assign"),
        };
        yield* setRole("implementor", "role:implementor");
        assert.equal(
          (yield* service.assignOrchestrator(input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
        yield* createRoot;
        assert.equal(
          (yield* service.assignOrchestrator(input).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* setRole("orchestrator", "role:eligible");
        yield* threads.dispatch({
          type: "message.dispatch",
          threadId: rootId,
          commandId: CommandId.make("role:busy"),
          messageId: MessageId.make("role:busy"),
          text: "Finish current work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const pending = yield* service.assignOrchestrator(input);
        assert.equal(pending.orchestration!.handoff?.status, "draining");
        yield* setRole("implementor", "role:changed-during-drain");
        yield* finish(rootId, "role:finished");
        const transfer = yield* threads
          .dispatch({
            type: "repository.work.handoff",
            threadId: rootId,
            commandId: CommandId.make("role:transfer"),
            expectedRevision: pending.orchestration!.revision,
            inventory: "Current repository work",
          })
          .pipe(Effect.result);
        assert.equal(transfer._tag, "Failure");
        if (transfer._tag === "Failure") assert.include(String(transfer.failure), "Orchestrator");
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        yield* worker.drain();
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect("rejects a role changed between initial validation and registration", () => {
    const target = ThreadId.make("initial-role-target");
    let changeRole = Effect.void;
    let mutate = true;
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      yield* createLead(target);
      const thread = (yield* threads.getThreadRecords(target, [])).thread;
      changeRole = sink
        .write({
          events: [
            {
              type: "thread.metadata-updated",
              id: EventId.make("registration:role-change"),
              threadId: target,
              occurredAt: yield* DateTime.now,
              payload: { ...thread, role: "implementor" },
            },
          ],
        })
        .pipe(Effect.asVoid, Effect.orDie);
      const result = yield* service
        .assignOrchestrator({
          ...reference,
          projectId,
          targetThreadId: target,
          clientRequestId: CommandId.make("registration:role-race"),
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.message, "top-level");
      assert.isNull((yield* service.repositoryStatus(reference)).rootThreadId);
      assert.equal((yield* threads.getThreadShell(target))!.role, "implementor");
    }).pipe(
      Effect.provide(
        fixture({
          recovery: true,
          wrapThreads: (threads) => ({
            ...threads,
            getThreadShell: (id) =>
              threads.getThreadShell(id).pipe(
                Effect.tap((shell) => {
                  if (id !== target || shell === null || !mutate) return Effect.void;
                  mutate = false;
                  // Return the old shell after a concurrent role change commits.
                  return changeRole;
                }),
              ),
          }),
        }),
      ),
    );
  });

  it.effect("rejects an unsupported provider changed during drain", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const target = ThreadId.make("provider-changed-target");
      yield* createRoot;
      yield* createLead(target);
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: rootId,
        commandId: CommandId.make("probe:busy"),
        messageId: MessageId.make("probe:busy"),
        text: "Finish current work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const pending = yield* service.assignOrchestrator({
        ...reference,
        projectId,
        targetThreadId: target,
        clientRequestId: CommandId.make("probe:assign"),
      });
      assert.equal(pending.orchestration!.handoff?.status, "draining");
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        threadId: target,
        commandId: CommandId.make("probe:provider-change"),
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "cursor-model" },
      });
      assert.equal((yield* threads.getThreadShell(target))!.modelSelection.instanceId, "cursor");
      yield* finish(rootId, "probe:finished");
      const transfer = yield* threads
        .dispatch({
          type: "repository.work.handoff",
          threadId: rootId,
          commandId: CommandId.make("provider:transfer"),
          expectedRevision: pending.orchestration!.revision,
          inventory: "Current repository work",
        })
        .pipe(Effect.result);
      assert.equal(transfer._tag, "Failure");
      if (transfer._tag === "Failure") assert.include(String(transfer.failure), "Codex or Claude");
      yield* service.reconcile(rootId).pipe(Effect.result);
      yield* worker.drain();
      const result = yield* service.repositoryStatus(reference);
      assert.equal(
        result.rootThreadId,
        rootId,
        "Unsupported Cursor target must not become repository owner",
      );
    }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "keeps an agent's existing handoff target when the user approves without resending it",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const target = ThreadId.make("agent-selected-successor");
        yield* createRoot;
        yield* createLead(target);
        const proposal = {
          ...reference,
          expectedRevision: 1,
          summary: "Continue in the selected conversation.",
          clientRequestId: CommandId.make("agent-target:propose"),
        };
        const self = yield* service
          .requestHandoff(rootId, { ...proposal, targetThreadId: rootId })
          .pipe(Effect.result);
        assert.equal(self._tag, "Failure");
        const pending = yield* service.requestHandoff(rootId, {
          ...proposal,
          targetThreadId: target,
        });
        assert.equal(pending.orchestration!.handoff?.status, "awaiting_approval");
        const approved = yield* service.handoff({
          ...proposal,
          expectedRevision: pending.orchestration!.revision,
          action: "approve",
          clientRequestId: CommandId.make("agent-target:approve"),
        });
        assert.equal(approved.rootThreadId, target);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  const registerInput = (targetThreadId: ThreadId, key: string) => ({
    ...restoreInput,
    expectedRootThreadId: null,
    expectedRevision: null,
    targetThreadId,
    clientRequestId: CommandId.make(key),
  });

  it.effect("an adopted lead's ownership survives a transfer through compacted rebuild", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const adopted = ThreadId.make("adopted-lead");
      const successor = ThreadId.make("successor-lead");
      yield* createLead(adopted);
      yield* createLead(successor);
      yield* service.restoreRoot(registerInput(adopted, "adopted:register"));
      yield* service.setPaused({
        ...reference,
        paused: true,
        clientRequestId: CommandId.make("adopted:pause"),
      });
      const owner = (yield* store.repositoryOwner(config))!;
      yield* service.restoreRoot({
        ...restoreInput,
        expectedRootThreadId: adopted,
        expectedRevision: owner.revision,
        targetThreadId: successor,
        clientRequestId: CommandId.make("adopted:transfer"),
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      // Compaction drops the adopted lead's registration snapshot and keeps its retired one.
      yield* maintenance.compactEventStore;
      assert.isTrue((yield* maintenance.rebuild).valid);
      const rebuilt = yield* store.repositoryOwner(config);
      assert.equal(rebuilt?.rootThreadId, successor);
      assert.equal(rebuilt?.revision, owner.revision + 1);
      assert.equal((yield* store.configuration(adopted))!.retiredToThreadId, successor);
    }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect("rejects a child restore target without taking locks a child follow-up holds", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const childId = yield* createOriginalLead;
      yield* service.restoreRoot(registerInput(originalLeadId, "lead:register"));
      // A user follow-up to the child holds the parent's lock, then takes the child's.
      const holdingParent = yield* Deferred.make<void>();
      const restoreRejected = yield* Deferred.make<void>();
      const followUp = yield* locks
        .withLock(
          originalLeadId,
          Deferred.succeed(holdingParent, undefined).pipe(
            Effect.andThen(Deferred.await(restoreRejected)),
            Effect.andThen(locks.withLock(childId, Effect.void)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holdingParent);
      const restored = yield* service
        .restoreRoot({
          ...restoreInput,
          expectedRootThreadId: originalLeadId,
          expectedRevision: 1,
          targetThreadId: childId,
          clientRequestId: CommandId.make("lead:restore-child"),
        })
        .pipe(Effect.result);
      assert.equal(restored._tag, "Failure");
      if (restored._tag === "Failure") assert.include(restored.failure.message, "top-level");
      yield* Deferred.succeed(restoreRejected, undefined);
      yield* Fiber.join(followUp);
    }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  // A missing target passing the pre-lock check could be created as a child before the locked read.
  it.effect("rejects a missing restore target before taking any lock", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      yield* createOriginalLead;
      yield* service.restoreRoot(registerInput(originalLeadId, "lead:register"));
      const holdingLead = yield* Deferred.make<void>();
      const restoreRejected = yield* Deferred.make<void>();
      const holder = yield* locks
        .withLock(
          originalLeadId,
          Deferred.succeed(holdingLead, undefined).pipe(
            Effect.andThen(Deferred.await(restoreRejected)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holdingLead);
      const restored = yield* service
        .restoreRoot({
          ...restoreInput,
          expectedRootThreadId: originalLeadId,
          expectedRevision: 1,
          targetThreadId: ThreadId.make("not-yet-created-lead"),
          clientRequestId: CommandId.make("lead:restore-missing"),
        })
        .pipe(Effect.result);
      assert.equal(restored._tag, "Failure");
      if (restored._tag === "Failure") assert.include(restored.failure.message, "top-level");
      yield* Deferred.succeed(restoreRejected, undefined);
      yield* Fiber.join(holder);
    }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect("a fresh Start request adopts a lead corrected after a rejected adoption", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const lead = ThreadId.make("corrected-lead");
      yield* createLead(lead);
      yield* threads.dispatch({
        type: "thread.archive",
        threadId: lead,
        commandId: CommandId.make("corrected-lead:archive"),
      });
      const input = {
        ...reference,
        number: 9,
        projectId,
        modelRoleId: "worker",

        orchestratorThreadId: lead,
      };
      const rejected = yield* service
        .start({ ...input, clientRequestId: CommandId.make("corrected-lead:start-archived") })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      yield* threads.dispatch({
        type: "thread.unarchive",
        threadId: lead,
        commandId: CommandId.make("corrected-lead:unarchive"),
      });
      const started = yield* service.start({
        ...input,
        clientRequestId: CommandId.make("corrected-lead:start-again"),
      });
      assert.equal(started.rootThreadId, lead);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "rejects stale restore revisions, mismatched identities and unsafe previous-root work",
    () =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* IssueWorkService.IssueWorkService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createOriginalLead;
        yield* createRecoveryRoot;
        yield* startWrongRoot;
        yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("unsafe:pause"),
        });
        for (const input of [
          {
            ...restoreInput,
            expectedRevision: 2,
            clientRequestId: CommandId.make("restore:stale"),
          },
          {
            ...restoreInput,
            repositoryId: "other-repo",
            clientRequestId: CommandId.make("restore:wrong-repo"),
          },
          {
            ...restoreInput,
            projectId: otherProjectId,
            clientRequestId: CommandId.make("restore:wrong-project"),
          },
          { ...restoreInput, clientRequestId: CommandId.make("restore:unfinished-root") },
        ])
          assert.equal((yield* service.restoreRoot(input).pipe(Effect.result))._tag, "Failure");
        yield* service.cancelRequest(cancelInput);
        // Cancellation is only a request transition. It must not interrupt an active lead.
        assert.isNotNull((yield* threads.getThreadShell(rootId))!.activeRunId);
        const run = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
        assert.equal(
          (yield* threads
            .dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make("cancelled:late-claim"),
              parentThreadId: rootId,
              parentRunId: run.id,
              parentNodeId: run.rootNodeId!,
              issue: linked(9),
              task: "Attempt to claim cancelled work",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isNull(yield* store.issueOwner(linked(9)));
        assert.equal(
          (yield* service
            .restoreRoot({
              ...restoreInput,
              clientRequestId: CommandId.make("restore:active-root"),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* store.repositoryOwner(config))!.rootThreadId, rootId);
        assert.isUndefined(
          (yield* threads.getThreadRecords(originalLeadId, [])).thread.repositoryOrchestration,
        );
      }).pipe(Effect.provide(fixture({ recovery: true }))),
  );

  it.effect(
    "only one concurrent revision wins, installs inventory first, and retains ownership/history through compacted rebuild",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRoot;
        const results = yield* Effect.all(
          ["one", "two"].map((key) =>
            service
              .handoff({
                ...reference,
                action: "approve",
                expectedRevision: 1,
                summary: `Continue approved decisions ${key}.`,
                clientRequestId: CommandId.make(`handoff:${key}`),
              })
              .pipe(Effect.result),
          ),
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        const first = yield* service.repositoryStatus(reference);
        assert.notEqual(first.rootThreadId, rootId);
        assert.deepEqual(
          first.orchestration!.handoffHistory?.map((entry) => entry.threadId),
          [rootId],
        );
        const firstThread = yield* threads.getThreadRecords(first.rootThreadId!, ["messages"]);
        assert.include(firstThread.messages[0]!.text, "Server recovery inventory:");
        assert.include(firstThread.messages[0]!.text, "Milestones:");
        assert.include(firstThread.messages[0]!.text, "#9 Issue 9");
        assert.include(firstThread.messages[0]!.text, "Pending changes:");
        assert.equal(firstThread.messages.filter((message) => message.role === "user").length, 1);
        const retired = yield* threads
          .dispatch({
            type: "issue.work.start",
            commandId: CommandId.make("retired:start"),
            threadId: rootId,
            issue: linked(9),
            workerModelSelection: modelSelection,

            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.result);
        assert.equal(retired._tag, "Failure");
        if (retired._tag === "Failure") assert.include(retired.failure.message, "retired");
        yield* finish(first.rootThreadId!, "first-root-closeout");
        const second = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: first.orchestration!.revision,
          summary: "Continue with the retained repository decisions.",
          clientRequestId: CommandId.make("handoff:second-generation"),
        });
        assert.notEqual(second.rootThreadId, first.rootThreadId);
        yield* finish(second.rootThreadId!, "second-root-closeout");
        const paused = yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("latest-root-pause"),
        });
        // These later complete-state events supersede the transfer metadata during compaction.
        for (const threadId of [rootId, first.rootThreadId!, second.rootThreadId!])
          yield* threads.dispatch({
            type: "thread.archive",
            threadId,
            commandId: CommandId.make(`archive:${threadId}`),
          });
        yield* threads.dispatch({
          type: "thread.unarchive",
          threadId: second.rootThreadId!,
          commandId: CommandId.make("restore-latest-root"),
        });
        yield* maintenance.compactEventStore;
        assert.isTrue((yield* maintenance.rebuild).valid);
        const rebuilt = yield* service.repositoryStatus(reference);
        assert.equal(rebuilt.rootThreadId, second.rootThreadId);
        assert.equal(rebuilt.orchestration!.revision, paused.orchestration!.revision);
        assert.isTrue(rebuilt.orchestration!.paused);
        assert.deepEqual(
          rebuilt.orchestration!.handoffHistory?.map((entry) => entry.threadId),
          [rootId, first.rootThreadId],
        );
        assert.equal((yield* store.configuration(rootId))!.retiredToThreadId, first.rootThreadId);
        assert.equal(
          (yield* store.configuration(first.rootThreadId!))!.retiredToThreadId,
          second.rootThreadId,
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "waits for nested workers and their final deliveries, keeps lineage, rejects retired MCP calls and guards archive/delete",
    () => {
      let githubIssues: number[] = [];
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const sink = yield* EventSink.EventSinkV2;
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("root:start"),
          threadId: rootId,
          messageId: MessageId.make("root:start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const delegate = (threadId: ThreadId, number: number) =>
          Effect.gen(function* () {
            const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
            const result = yield* threads.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make(`delegate:${number}`),
              parentThreadId: threadId,
              parentRunId: run.id,
              parentNodeId: run.rootNodeId!,
              issue: linked(number),
              task: `Finish issue ${number}`,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            });
            const created = result.storedEvents.find(
              (stored) => stored.event.type === "thread.created",
            )!;
            return created.event.threadId;
          });
        const parent = yield* delegate(rootId, 1);
        const child = yield* delegate(parent, 2);
        yield* service.reconcile(rootId);
        const revision = (yield* service.repositoryStatus(reference)).orchestration!.revision;
        const pending = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: revision,
          summary: "Retain nested issue outcomes and continue issue 9.",
          clientRequestId: CommandId.make("handoff:nested"),
        });
        githubIssues = [1, 2, 9];
        assert.equal(pending.rootThreadId, rootId);
        assert.equal(pending.orchestration!.handoff?.status, "draining");
        const nextId = pending.orchestration!.handoff!.nextThreadId;
        assert.isNull(yield* threads.getThreadShell(nextId));
        for (const type of ["thread.archive", "thread.delete"] as const) {
          const blocked = yield* threads
            .dispatch({ type, threadId: rootId, commandId: CommandId.make(`blocked:${type}`) })
            .pipe(Effect.result);
          assert.equal(blocked._tag, "Failure");
          if (blocked._tag === "Failure") assert.match(blocked.failure.message, /hand.?off/i);
        }
        yield* finish(rootId, "root-waits");
        yield* finish(parent, "parent-waits");
        const beforeChild = yield* sink.latestSequence();
        yield* finish(child, "nested-child");
        yield* awaitFollowup(parent, beforeChild);
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        const beforeParent = yield* sink.latestSequence();
        yield* finish(parent, "parent-delivery");
        yield* awaitFollowup(rootId, beforeParent);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        const beforeRoot = yield* sink.latestSequence();
        yield* finish(rootId, "root-delivery");
        yield* sink.stream({ afterSequence: beforeRoot, eventType: "thread.created" }).pipe(
          Stream.filter((stored) => stored.event.threadId === nextId),
          Stream.take(1),
          Stream.runDrain,
        );
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        assert.equal(
          (yield* threads.getThreadRecords(child, [])).thread.lineage.parentThreadId,
          parent,
        );
        assert.equal(
          (yield* threads.getThreadRecords(parent, [])).thread.lineage.rootThreadId,
          rootId,
        );
        const inventory = (yield* threads.getThreadRecords(nextId, ["messages"])).messages[0]!.text;
        assert.include(inventory, "Completed attempts:");
        assert.include(inventory, "Evidence retained.");
        assert.include(inventory, "#9 Issue 9");
        const milestone = yield* mcp
          .workMilestone(scope(rootId), {
            ...reference,
            projectId,
            modelRoleId: "worker",

            milestoneNumber: 1,
            clientRequestId: CommandId.make("retired:milestone"),
          })
          .pipe(Effect.result);
        assert.equal(milestone._tag, "Failure");
        if (milestone._tag === "Failure") assert.include(milestone.failure.message, "retired");
        const delegation = yield* mcp
          .delegateTask(scope(rootId), {
            issue: { ...reference, number: 9 },
            task: "Try to delegate after retirement",
            mode: "async",
            clientRequestId: "retired:delegate",
          })
          .pipe(Effect.result);
        assert.equal(delegation._tag, "Failure");
        if (delegation._tag === "Failure") assert.include(delegation.failure.message, "retired");
        const authority = yield* service.assertCurrentCaller(parent).pipe(Effect.result);
        assert.equal(authority._tag, "Failure");
        if (authority._tag === "Failure") assert.equal(authority.failure.code, "retired-root");
        // Retired roots and their descendants cannot create, change or delete repository schedules.
        const scheduledTaskId = ScheduledTaskId.make("retired:schedule");
        for (const caller of [rootId, parent]) {
          for (const attempt of [
            mcp
              .scheduleTask(scope(caller), {
                prompt: "Check repository progress",
                schedule: { type: "interval", everyMs: 3_600_000 },
              })
              .pipe(Effect.asVoid),
            mcp
              .updateScheduledTask(scope(caller), { scheduledTaskId, enabled: false })
              .pipe(Effect.asVoid),
            mcp.deleteScheduledTask(scope(caller), { scheduledTaskId }).pipe(Effect.asVoid),
          ]) {
            const scheduled = yield* attempt.pipe(Effect.result);
            assert.equal(scheduled._tag, "Failure");
            if (scheduled._tag === "Failure") assert.include(scheduled.failure.message, "retired");
          }
        }
      }).pipe(Effect.provide(fixture({ continuation: true, inventoryIssues: () => githubIssues })));
    },
  );

  it.effect(
    "MCP requests require exact user approval and can be cancelled without moving ownership",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createRoot;
        const input = {
          ...reference,
          expectedRevision: 1,
          summary: "Decisions to preserve.",
          clientRequestId: CommandId.make("handoff:proposal"),
        };
        const proposed = yield* mcp.requestRepositoryHandoff(scope(rootId), input);
        assert.equal(proposed.orchestration!.handoff?.status, "awaiting_approval");
        assert.isFalse(proposed.orchestration!.paused);
        assert.isNull(yield* threads.getThreadShell(proposed.orchestration!.handoff!.nextThreadId));
        const stale = yield* service
          .handoff({
            ...input,
            action: "approve",
            expectedRevision: proposed.orchestration!.revision,
            summary: "A different proposal",
            clientRequestId: CommandId.make("handoff:wrong-approval"),
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        const paused = yield* service.setPaused({
          ...reference,
          paused: true,
          clientRequestId: CommandId.make("handoff:pause-before-approval"),
        });
        const approved = yield* service.handoff({
          ...input,
          action: "approve",
          expectedRevision: paused.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:user-approved"),
        });
        assert.notEqual(approved.rootThreadId, rootId);
        assert.isTrue(approved.orchestration!.paused);
        const nextProposal = yield* mcp.requestRepositoryHandoff(scope(approved.rootThreadId!), {
          ...input,
          expectedRevision: approved.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:next-proposal"),
        });
        const cancelled = yield* service.handoff({
          ...reference,
          action: "cancel",
          expectedRevision: nextProposal.orchestration!.revision,
          clientRequestId: CommandId.make("handoff:cancel"),
        });
        assert.equal(cancelled.rootThreadId, approved.rootThreadId);
        assert.isUndefined(cancelled.orchestration!.handoff);
        assert.isTrue(cancelled.orchestration!.paused);
      }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "retries incomplete inventory and rejected transfer attempts until the first prompt is committed",
    () => {
      let complete = false;
      let available = false;
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* IssueWorkStore.IssueWorkStore;
        yield* createRoot;
        const failed = yield* service
          .handoff({
            ...reference,
            action: "approve",
            expectedRevision: 1,
            summary: "Recover this handoff after access returns.",
            clientRequestId: CommandId.make("handoff:recovery"),
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const waiting = yield* service.repositoryStatus(reference);
        const nextId = waiting.orchestration!.handoff!.nextThreadId;
        assert.include(yield* store.activeRoots(), rootId);
        assert.equal(waiting.rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        complete = true;
        assert.equal((yield* service.reconcile(rootId).pipe(Effect.result))._tag, "Failure");
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));
        available = true;
        yield* service.reconcile(rootId);
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        const messages = (yield* threads.getThreadRecords(nextId, ["messages"])).messages;
        assert.equal(messages.length, 1);
        assert.include(messages[0]!.text, "Recover this handoff after access returns.");
        assert.include(messages[0]!.text, "Server recovery inventory:");
      }).pipe(
        Effect.provide(
          fixture({ inventoryComplete: () => complete, providerAvailable: () => available }),
        ),
      );
    },
  );

  it.effect(
    "transfers once when a reconcile arrives while the event loop drains the handoff",
    () => {
      let parkTransfer = false;
      let listings: number | undefined;
      const parked = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const draining = Deferred.makeUnsafe<void>();
      return Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("race:root-start"),
          threadId: rootId,
          messageId: MessageId.make("race:root-start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const pending = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Transfer once.",
          clientRequestId: CommandId.make("handoff:race"),
        });
        const nextId = pending.orchestration!.handoff!.nextThreadId;
        // Once the root's turn ends, the event loop drains it and parks inside the transfer.
        parkTransfer = true;
        yield* finish(rootId, "race-root");
        yield* Deferred.await(parked);
        // Reconcile lists admission threads immediately before it drains.
        listings = 0;
        const reconcile = yield* service.reconcile(rootId).pipe(Effect.forkChild);
        yield* Deferred.await(draining);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reconcile);

        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        assert.lengthOf((yield* threads.getThreadRecords(nextId, ["messages"])).messages, 1);
      }).pipe(
        Effect.provide(
          fixture({
            beforeCapabilities: () => {
              if (!parkTransfer) return Effect.void;
              parkTransfer = false;
              return Deferred.succeed(parked, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            },
            wrapStore: (store) => ({
              ...store,
              admissionThreads: (rootThreadId) =>
                store
                  .admissionThreads(rootThreadId)
                  .pipe(
                    Effect.tap(() =>
                      listings !== undefined && ++listings === 1
                        ? Deferred.succeed(draining, undefined)
                        : Effect.void,
                    ),
                  ),
            }),
          }),
        ),
      );
    },
  );

  it.effect(
    "keeps a handoff draining while a restart continuation is pending and drops it after retirement",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart:root-start"),
          threadId: rootId,
          messageId: MessageId.make("restart:root-start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const cut = (yield* threads.getThreadRecords(rootId, ["runs"])).runs.at(-1)!;
        const now = yield* DateTime.now;
        // What startup recovery commits: the cut run is cancelled and its continuation queued.
        yield* sink.writeWithEffects({
          events: [
            {
              id: EventId.make("restart:cancel-cut-run"),
              type: "run.updated",
              threadId: rootId,
              runId: cut.id,
              occurredAt: now,
              payload: { ...cut, status: "cancelled", completedAt: now },
            },
          ],
          effects: [
            {
              id: `effect:restart-continuation:${cut.id}`,
              commandId: CommandId.make("restart:recovery"),
              threadId: rootId,
              request: { type: "provider-runtime.continue", sourceRunId: cut.id },
            },
          ],
        });
        const draining = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Continue after the restart.",
          clientRequestId: CommandId.make("handoff:restart"),
        });
        const nextId = draining.orchestration!.handoff!.nextThreadId;
        assert.equal(draining.rootThreadId, rootId);
        assert.isNull(yield* threads.getThreadShell(nextId));

        yield* outbox.cancelUnsettled({
          threadId: rootId,
          effectTypes: ["provider-runtime.continue"],
          reason: "The continuation settled.",
        });
        yield* service.reconcile(rootId);
        assert.equal((yield* service.repositoryStatus(reference)).rootThreadId, nextId);
        // A continuation that reaches dispatch after retirement is accepted as a no-op.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:restart-continuation:${cut.id}`),
          threadId: rootId,
          messageId: MessageId.make(`message:restart-continuation:${cut.id}`),
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          restartContinuationOfRunId: cut.id,
        });
        const root = yield* threads.getThreadRecords(rootId, ["runs"]);
        assert.deepEqual(
          root.runs.map((run) => run.id),
          [cut.id],
        );
      }).pipe(Effect.provide(fixture())),
  );

  it.effect("resends a scheduled prompt to the new owner when a handoff commits mid-dispatch", () =>
    Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      yield* createRoot;
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "handoff-schedule",
        title: "Repository check-in",
        prompt: "Review repository progress",
        enabled: 0,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: projectId,
        thread_id: null,
        repository_target_json: '{"host":"github.com","repositoryId":"repo:handoff"}',
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5.1-codex"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: "2026-10-05T00:00:00.000Z",
        updated_at: "2026-10-05T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      const reached = yield* Deferred.make<ThreadId>();
      const release = yield* Deferred.make<void>();
      let gated = true;
      // Holds the first send after the owner was resolved, so the handoff commits in between.
      const gatedThreads = Layer.succeed(ThreadManagement.ThreadManagementService, {
        ...threads,
        sendToThread: (input) =>
          Effect.gen(function* () {
            if (gated) {
              gated = false;
              yield* Deferred.succeed(reached, input.threadId);
              yield* Deferred.await(release);
            }
            return yield* threads.sendToThread(input);
          }),
      });
      const result = yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const fiber = yield* tasks
          .runNow({ id: ScheduledTaskId.make("handoff-schedule") })
          .pipe(Effect.forkChild);
        assert.equal(yield* Deferred.await(reached), rootId);
        const moved = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Take over scheduled check-ins.",
          clientRequestId: CommandId.make("handoff:schedule"),
        });
        assert.notEqual(moved.rootThreadId, rootId);
        yield* Deferred.succeed(release, undefined);
        return { run: yield* Fiber.join(fiber), nextId: moved.rootThreadId! };
      }).pipe(
        Effect.provide(
          ScheduledTasks.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                gatedThreads,
                Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
                Layer.mock(SecretRequests.SecretRequests)({}),
              ),
            ),
          ),
        ),
      );
      assert.equal(result.run.task.lastRunStatus, "succeeded");
      const scheduled = (threadId: ThreadId) =>
        threads
          .getThreadRecords(threadId, ["messages"])
          .pipe(
            Effect.map((records) =>
              records.messages.filter((message) => message.scheduledTaskId !== undefined),
            ),
          );
      assert.lengthOf(yield* scheduled(rootId), 0);
      assert.lengthOf(yield* scheduled(result.nextId), 1);
    }).pipe(Effect.provide(fixture())),
  );

  it.effect(
    "routes a remaining sub-issue through a successor parent attempt under the new root",
    () =>
      Effect.gen(function* () {
        const service = yield* IssueWorkService.IssueWorkService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const delegate = (threadId: ThreadId, number: number, key: string) =>
          Effect.gen(function* () {
            const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.findLast(
              (entry) => ["starting", "running", "waiting"].includes(entry.status),
            )!;
            const result = yield* threads.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make(`successor:${key}`),
              parentThreadId: threadId,
              parentRunId: run.id,
              parentNodeId: run.rootNodeId!,
              issue: linked(number),
              task: `Finish issue ${number}`,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            });
            return result.storedEvents.find((stored) => stored.event.type === "thread.created")!
              .event.threadId;
          });
        const texts = (threadId: ThreadId) =>
          threads
            .getThreadRecords(threadId, ["messages"])
            .pipe(Effect.map((records) => records.messages.map((message) => message.text)));
        yield* createRoot;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("successor:root-start"),
          threadId: rootId,
          messageId: MessageId.make("successor:root-start"),
          text: "Work through milestone 1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        // Parent issue #1 finishes under the old root; its sub-issue #2 is still open.
        const oldParent = yield* delegate(rootId, 1, "old-parent");
        yield* finish(rootId, "successor-root-waits");
        const beforeParent = yield* sink.latestSequence();
        yield* finish(oldParent, "successor-old-parent");
        yield* awaitFollowup(rootId, beforeParent);
        yield* finish(rootId, "successor-root-delivery");
        const moved = yield* service.handoff({
          ...reference,
          action: "approve",
          expectedRevision: 1,
          summary: "Continue the remaining sub-issue.",
          clientRequestId: CommandId.make("handoff:successor"),
        });
        const nextId = moved.rootThreadId!;
        assert.notEqual(nextId, rootId);
        const oldParentMessages = (yield* texts(oldParent)).length;
        const rootMessages = (yield* texts(nextId)).length;

        yield* threads.dispatch({
          type: "issue.work.start",
          commandId: CommandId.make("successor:start-sub-issue"),
          threadId: nextId,
          issue: linked(2),
          workerModelSelection: modelSelection,

          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* service.reconcile(nextId);
        assert.lengthOf(yield* texts(oldParent), oldParentMessages);
        assert.lengthOf(yield* texts(nextId), rootMessages);

        const newParent = (yield* (yield* IssueWorkStore.IssueWorkStore).currentIssueOwner(
          linked(1),
        ))!;
        assert.notEqual(newParent, oldParent);
        yield* service.reconcile(nextId);
        const newLeaf = (yield* (yield* IssueWorkStore.IssueWorkStore).currentIssueOwner(
          linked(2),
        ))!;
        assert.equal(
          (yield* threads.getThreadRecords(newLeaf, [])).thread.lineage.parentThreadId,
          newParent,
        );
        assert.lengthOf(yield* texts(newParent), 1);
        assert.equal((yield* threads.getThreadRecords(newParent, ["runs"])).runs.length, 1);
        assert.lengthOf(yield* texts(oldParent), oldParentMessages);
        assert.equal(
          (yield* threads.getThreadRecords(oldParent, [])).thread.lineage.rootThreadId,
          rootId,
        );
      }).pipe(Effect.provide(fixture({ continuation: true, inventoryIssues: () => [] }))),
  );
});
