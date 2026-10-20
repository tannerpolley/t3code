import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import { RuntimeRequestId, type OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import * as EventSink from "./EventSink.ts";
import { EventId, effectiveThreadRole } from "@t3tools/contracts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  createReviewRoot,
  delegateReviewIssue,
  launchInput,
  makeHarness,
  modelSelection,
  otherProjectId,
  projectId,
  reviewHarness,
  reviewIssue,
  reviewRead,
  suspensionWorkerLayer,
} from "./ThreadLaunchService.testHarness.ts";

describe("managed issue work", () => {
  const exercise = (scenario: "baseline" | "direct-resume" | "deletion") => {
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
    const issue = {
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repository:8",
      id: "issue:8",
      nodeId: "node:8",
      number: 8,
      url: "https://github.com/tannerpolley/t3code/issues/8",
      title: "Single issue",
    };
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: { ...issue, number: input.number },
        state: "open" as const,
        milestoneNumber: null,
        parent: null,
        subIssues: [],
        blockedBy: [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: true,
      });
    const harness = makeHarness({
      runContinuationWorker: scenario === "direct-resume",
      issueServiceLayer: Layer.mock(IssueService.IssueService)({ workRead }),
      localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
      hasCommit: () => Effect.succeed(true),
      providers: [provider],
      projectRepositoryIdentity: {
        canonicalKey: "github.com/tannerpolley/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/tannerpolley/t3code.git",
        },
        provider: "github",
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
    });
    const store = IssueWorkStore.layer.pipe(Layer.provide(harness.layer));
    const published = new Map<string, { commentId: string; body: string }>();
    const writeCalls: Array<
      Parameters<IssueService.IssueService["Service"]["writeManagedComment"]>[0]
    > = [];
    const issueReads = Layer.mock(IssueService.IssueService)({
      repositoryIdentity: () => Effect.succeed(issue),
      workRead,
      writeManagedComment: (request) =>
        Effect.sync(() => {
          writeCalls.push(request);
          const commentId =
            published.get(request.marker)?.commentId ?? `comment-${published.size + 1}`;
          published.set(request.marker, { commentId, body: request.body });
          return { commentId };
        }),
      resolveLinkedIssue: () => Effect.succeed(issue),
      detail: () =>
        Effect.succeed({
          repository: { host: issue.host, repository: issue.repository },
          viewer: null,
          fetchedAt: "2026-10-05T00:00:00Z",
          issue: {
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: "open",
            stateReason: null,
            author: null,
            assignees: [],
            labels: [],
            milestone: null,
            createdAt: "2026-10-05T00:00:00Z",
            updatedAt: "2026-10-05T00:00:00Z",
            commentCount: 0,
          },
          body: "Finish this issue",
          comments: [],
          linkedPullRequests: [],
        }),
    });
    const dependencies = Layer.mergeAll(
      harness.layer,
      store,
      issueReads,
      IdAllocator.layer,
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
    );
    const service = IssueWorkService.layer.pipe(Layer.provide(dependencies));
    const realExecutor = Layer.fresh(EffectWorker.layerExecutor).pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
          Layer.mock(RunFinalizationService.RunFinalizationService)({}),
          Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
          Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
          Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        ),
      ),
    );
    // Exercise the real comment executor/worker; provider subprocess effects are
    // deliberately inert in this offline proof.
    const commentExecutor = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect, options) =>
            effect.request.type === "issue.github.comment" ||
            effect.request.type === "issue.status.refresh"
              ? executor.execute(effect, options)
              : Effect.void,
        });
      }),
    ).pipe(Layer.provide(realExecutor));
    const commentWorker = EffectWorker.layerWithOptions({}).pipe(
      Layer.provide(Layer.mergeAll(dependencies, commentExecutor)),
    );
    const testLayer = Layer.mergeAll(service, commentExecutor, commentWorker).pipe(
      Layer.provideMerge(dependencies),
    );
    return Effect.gen(function* () {
      const issues = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const selectedLeadId = ThreadId.make("issue-selected-existing-lead");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("issue-selected-existing-lead:create"),
        threadId: selectedLeadId,
        projectId,
        title: "Existing repository lead",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const input = {
        host: issue.host,
        repository: issue.repository,
        number: issue.number,
        projectId,
        orchestratorThreadId: selectedLeadId,
        modelRoleId: "worker",
      };
      const starts = yield* Effect.all(
        [
          issues.start({ ...input, clientRequestId: CommandId.make("issue-click:first") }),
          issues.start({ ...input, clientRequestId: CommandId.make("issue-click:second") }),
        ],
        { concurrency: 2 },
      );
      assert.equal(starts[0].rootThreadId, starts[1].rootThreadId);
      assert.equal(starts[0].rootThreadId, selectedLeadId);
      assert.isFalse(starts[0].createdRoot);
      assert.isFalse(starts[1].createdRoot);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_repository_orchestration`).length,
        1,
      );
      const initialRoot = yield* threads.getThreadProjection(starts[0].rootThreadId);
      assert.lengthOf(initialRoot.messages, 0);
      assert.lengthOf(initialRoot.runs, 0);
      assert.lengthOf(initialRoot.subagents, 1);
      assert.isNotNull(starts[0].issueThreadId);
      yield* threads.sendToThread({
        projectId,
        threadId: starts[0].rootThreadId,
        commandId: CommandId.make("issue-root:orchestrate"),
        messageId: MessageId.make("issue-root:orchestrate"),
        text: "Orchestrate the issue workers",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const root = yield* threads.getThreadProjection(starts[0].rootThreadId);
      // The root stores no role; it works as an Orchestrator by default.
      assert.equal(effectiveThreadRole(root.thread), "orchestrator");
      assert.equal(root.messages.length, 1);
      assert.equal((yield* issues.workStatus(input)).status, "queued_preparing");
      assert.equal((yield* issues.workStatus(input)).projectId, projectId);
      const unstartedIssue = yield* issues.workStatus({
        host: issue.host,
        repository: issue.repository,
        number: 9,
      });
      assert.equal(unstartedIssue.projectId, projectId);
      assert.equal(unstartedIssue.rootThreadId, root.thread.id);
      assert.isNull(unstartedIssue.status);
      assert.equal(
        yield* (yield* IssueWorkStore.IssueWorkStore).issueOwner(issue),
        starts[0].issueThreadId,
      );
      const otherProjectStart = yield* issues
        .start({
          ...input,
          projectId: otherProjectId,
          clientRequestId: CommandId.make("issue-click:other-project"),
        })
        .pipe(Effect.result);
      assert.isTrue(otherProjectStart._tag === "Failure");
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_repository_orchestration`).length,
        1,
      );
      yield* worker.drain();
      assert.equal(published.size, 1);
      assert.equal(
        yield* (yield* IssueWorkStore.IssueWorkStore).issueOwner(issue),
        starts[0].issueThreadId,
      );
      const parentRun = root.runs[0]!;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("issue-delegate:first"),
        parentThreadId: root.thread.id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        issue,
        task: "Finish the issue",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        completionWake: "always" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const missingIssue = yield* threads
        .dispatch({
          ...command,
          commandId: CommandId.make("issue-delegate:missing"),
          issue: undefined,
        })
        .pipe(Effect.result);
      assert.isTrue(missingIssue._tag === "Failure");
      const reuseResults = yield* Effect.all(
        [
          threads.dispatch(command).pipe(Effect.result),
          threads
            .dispatch({ ...command, commandId: CommandId.make("issue-delegate:second-reuse") })
            .pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      const successful = reuseResults.filter((result) => result._tag === "Success");
      assert.equal(successful.length, 2);
      assert.equal(reuseResults.filter((result) => result._tag === "Failure").length, 0);
      assert.isFalse(
        successful.some(
          (result) =>
            result._tag === "Success" &&
            result.success.storedEvents.some((stored) => stored.event.type === "thread.created"),
        ),
      );
      const acceptedDelegate = successful[0];
      if (acceptedDelegate?._tag !== "Success")
        return yield* Effect.die("No accepted issue worker");
      const delegated = acceptedDelegate.success;
      const taskEvent = delegated.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      assert.isDefined(taskEvent);
      if (
        taskEvent?.event.type !== "subagent.updated" ||
        taskEvent.event.payload.childThreadId === null
      )
        return yield* Effect.die("No issue worker");
      // Preparation runs in the background; read the worker once it has its worktree.
      yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker)
        .stream(taskEvent.event.payload.childThreadId)
        .pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
      const child = yield* threads.getThreadProjection(taskEvent.event.payload.childThreadId);
      assert.deepEqual(child.thread.linkedIssue, issue);
      assert.equal(child.thread.role, "implementor");
      assert.equal(
        effectiveThreadRole((yield* threads.getThreadProjection(root.thread.id)).thread),
        "orchestrator",
      );
      assert.equal(child.thread.title, "#8 Single issue");
      const duplicate = yield* threads
        .dispatch({ ...command, commandId: CommandId.make("issue-delegate:duplicate") })
        .pipe(Effect.result);
      assert.isTrue(duplicate._tag === "Success");
      assert.equal((yield* threads.getThreadProjection(root.thread.id)).subagents.length, 1);
      const archive = yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("issue-root:archive"),
          threadId: root.thread.id,
        })
        .pipe(Effect.result);
      assert.isTrue(archive._tag === "Failure");
      const deletion = yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make("issue-root:delete"),
          threadId: root.thread.id,
        })
        .pipe(Effect.result);
      assert.isTrue(deletion._tag === "Failure");
      // The worker's workspace preparation runs on its own fiber; wait until it releases the run.
      yield* sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === child.thread.id &&
            stored.event.type === "run.updated" &&
            stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const childRun = (yield* threads.getThreadProjection(child.thread.id)).runs[0]!;
      const now = yield* DateTime.now;
      if (childRun.activeAttemptId === null) return yield* Effect.die("No current worker attempt");
      const running = { ...childRun, status: "running" as const, startedAt: now };
      const started = yield* sink.writeIfRunCurrent({
        threadId: child.thread.id,
        runId: childRun.id,
        activeAttemptId: childRun.activeAttemptId,
        expectedStatus: childRun.status,
        events: [
          {
            id: EventId.make("issue-worker:running"),
            type: "run.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: running,
          },
        ],
      });
      assert.isTrue(started.committed);
      assert.equal((yield* issues.workStatus(input)).status, "working");
      yield* worker.drain();
      const request: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("issue-native-permission"),
        nodeId: childRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "permission-1",
          strength: "strong",
        },
        kind: "permission",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:native-permission"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: request,
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "waiting_on_you");
      const dynamicRequest: OrchestrationV2RuntimeRequest = {
        ...request,
        id: RuntimeRequestId.make("issue-native-dynamic-tool"),
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "dynamic-1",
          strength: "strong",
        },
        kind: "dynamic_tool_call",
        createdAt: DateTime.add(now, { milliseconds: 1 }),
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:newer-dynamic-tool"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: dynamicRequest.createdAt,
            payload: dynamicRequest,
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "waiting_on_you");
      assert.equal(
        (yield* threads.getThreadShell(child.thread.id))?.pendingRuntimeRequest?.kind,
        "dynamic_tool_call",
      );
      yield* worker.drain();
      const waitingRows = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'issue.github.comment' AND json_extract(payload_json, '$.status') = 'waiting_on_you' ORDER BY rowid DESC LIMIT 1`;
      const staleWaiting = Option.getOrThrow(yield* outbox.get(waitingRows[0]!.effect_id));
      yield* worker.drain();
      assert.isTrue(
        [...published.values()].some((comment) => comment.body.includes("Waiting on you")),
      );
      if (scenario === "deletion") {
        yield* threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("issue-worker:delete"),
          threadId: child.thread.id,
        });
        assert.equal((yield* issues.workStatus(input)).status, "unavailable");
        // The latest published key still names Waiting on you until refresh runs.
        // Replaying it here proves deletion itself rejects stale writes.
        const before = writeCalls.length;
        yield* executor.execute(staleWaiting);
        assert.equal(writeCalls.length, before);
        yield* worker.drain();
        const statuses = writeCalls.filter((call) => call.operation === "status_sync");
        assert.include(statuses.at(-1)!.body, "Unavailable");
        const afterDeletion = writeCalls.length;
        yield* executor.execute(staleWaiting);
        assert.equal(writeCalls.length, afterDeletion);
        return;
      }
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:permission-answered"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...request, status: "resolved", resolvedAt: now },
          },
        ],
      });
      assert.equal((yield* issues.workStatus(input)).status, "working");
      yield* worker.drain();
      yield* sink.write({
        events: [
          {
            id: EventId.make("issue-worker:dynamic-resolved"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...dynamicRequest, status: "resolved", resolvedAt: now },
          },
          {
            id: EventId.make("issue-worker:permission-resolved"),
            type: "runtime-request.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...request, status: "resolved", resolvedAt: now },
          },
          {
            id: EventId.make("issue-worker:final-message"),
            type: "message.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("issue-final-message"),
              threadId: child.thread.id,
              runId: childRun.id,
              nodeId: childRun.rootNodeId,
              role: "assistant",
              text: "Implementation complete. Focused checks passed; push approval remains.",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          },
          {
            id: EventId.make("issue-worker:finished"),
            type: "run.updated",
            threadId: child.thread.id,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...running, status: "completed", completedAt: now },
          },
        ],
      });
      const beforeStaleRetry = writeCalls.length;
      yield* executor.execute(staleWaiting);
      assert.equal(writeCalls.length, beforeStaleRetry);
      yield* orchestrator.recoverDelegatedTask(child.thread.id, childRun.id);
      yield* worker.drain();
      assert.equal(published.size, 2);
      assert.equal(writeCalls.filter((call) => call.operation === "closeout_create").length, 1);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
        1,
      );
      const closeouts = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE json_extract(payload_json, '$.operation') = 'closeout_create'`;
      assert.equal(closeouts.length, 1);
      const closeout = Option.getOrThrow(yield* outbox.get(closeouts[0]!.effect_id));
      yield* executor.execute(closeout);
      yield* orchestrator.recoverDelegatedTask(child.thread.id, childRun.id);
      yield* worker.drain();
      assert.equal(writeCalls.filter((call) => call.operation === "closeout_create").length, 1);
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
        1,
      );
      assert.equal((yield* issues.workStatus(input)).status, "done");
      if (scenario === "direct-resume") {
        const originalTaskId = taskEvent.event.payload.id;
        yield* sink.stream({ afterSequence: 0, eventType: "message.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === root.thread.id &&
              stored.event.type === "message.updated" &&
              stored.event.payload.delegatedCompletion?.taskIds.includes(originalTaskId) === true,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const before = yield* threads.getThreadProjection(root.thread.id);
        const originalTask = before.subagents.find((task) => task.id === originalTaskId)!;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("issue-worker:direct-followup"),
          threadId: child.thread.id,
          messageId: MessageId.make("issue-worker:direct-followup"),
          text: "Finish the local follow-up",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const resumed = (yield* threads.getThreadProjection(child.thread.id)).runs.at(-1)!;
        assert.isDefined(resumed.delegatedTaskId);
        assert.notEqual(resumed.delegatedTaskId, originalTask.id);
        const finishedAt = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("issue-worker:followup-result"),
              type: "message.updated",
              threadId: child.thread.id,
              runId: resumed.id,
              occurredAt: finishedAt,
              payload: {
                id: MessageId.make("issue-worker:followup-result"),
                threadId: child.thread.id,
                runId: resumed.id,
                nodeId: resumed.rootNodeId,
                role: "assistant",
                text: "Follow-up complete.",
                attachments: [],
                streaming: false,
                createdAt: finishedAt,
                updatedAt: finishedAt,
                createdBy: "agent",
                creationSource: "provider",
              },
            },
            {
              id: EventId.make("issue-worker:followup-finished"),
              type: "run.updated",
              threadId: child.thread.id,
              runId: resumed.id,
              occurredAt: finishedAt,
              payload: {
                ...resumed,
                status: "completed",
                startedAt: finishedAt,
                completedAt: finishedAt,
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTask(child.thread.id, resumed.id);
        yield* worker.drain();
        yield* orchestrator.recoverDelegatedTask(child.thread.id, resumed.id);
        yield* worker.drain();
        yield* sink.stream({ afterSequence: 0, eventType: "message.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === root.thread.id &&
              stored.event.type === "message.updated" &&
              stored.event.payload.delegatedCompletion?.taskIds.includes(
                resumed.delegatedTaskId!,
              ) === true,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const closeoutCalls = writeCalls.filter((call) => call.operation === "closeout_create");
        assert.equal(closeoutCalls.length, 2);
        assert.include(closeoutCalls[1]!.body, "Follow-up complete.");
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_projection_issue_comment_receipts`).length,
          2,
        );
        const after = yield* threads.getThreadProjection(root.thread.id);
        assert.deepEqual(
          after.subagents.find((task) => task.id === originalTask.id),
          originalTask,
        );
        assert.equal(
          after.subagents.find((task) => task.id === resumed.delegatedTaskId)?.result,
          "Follow-up complete.",
        );
        assert.sameMembers(
          after.contextTransfers
            .filter((transfer) => transfer.type === "subagent_result")
            .map((transfer) => transfer.sourcePoint.runId),
          [childRun.id, resumed.id],
        );
        const deliveries = after.messages.filter(
          (message) => message.delegatedCompletion !== undefined,
        );
        assert.sameMembers(
          deliveries.flatMap((message) => message.delegatedCompletion!.taskIds),
          [originalTask.id, resumed.delegatedTaskId!],
        );
        for (const message of deliveries) {
          assert.lengthOf(
            after.runs.filter((run) => run.userMessageId === message.id),
            1,
          );
        }
        return;
      }
      const rootHistoryBeforeRetry = yield* threads.getThreadRecords(root.thread.id, [
        "messages",
        "runs",
      ]);
      const retry = yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:first"),
      });
      assert.equal(retry.rootThreadId, root.thread.id);
      assert.deepEqual(
        (yield* threads.getThreadRecords(root.thread.id, ["messages", "runs"])).messages,
        rootHistoryBeforeRetry.messages,
      );
      assert.equal(
        (yield* sql`SELECT * FROM orchestration_v2_projection_issue_work_requests`).length,
        2,
      );
      const issueStore = yield* IssueWorkStore.IssueWorkStore;
      const successor = yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:successor"),
      });
      assert.equal(successor.rootThreadId, root.thread.id);
      assert.equal(yield* issueStore.issueOwner(issue), successor.issueThreadId);
      assert.notEqual(successor.issueThreadId, child.thread.id);
      assert.equal((yield* issues.workStatus(input)).status, "queued_preparing");
      assert.equal((yield* issues.workStatus(input)).threadId, successor.issueThreadId);
      yield* issues.start({
        ...input,
        clientRequestId: CommandId.make("issue-click:successor-duplicate"),
      });
      assert.deepEqual(
        (yield* threads.getThreadRecords(root.thread.id, ["messages", "runs"])).messages,
        rootHistoryBeforeRetry.messages,
      );
      yield* issues.start({ ...input, clientRequestId: CommandId.make("issue-click:first") });
      assert.deepEqual(
        (yield* threads.getThreadRecords(root.thread.id, ["messages", "runs"])).messages,
        rootHistoryBeforeRetry.messages,
      );
      const successorResult = yield* threads.dispatch({
        ...command,
        commandId: CommandId.make("issue-delegate:successor"),
      });
      const successorTask = successorResult.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      if (
        successorTask?.event.type !== "subagent.updated" ||
        successorTask.event.payload.childThreadId === null
      )
        return yield* Effect.die("No successor worker");
      assert.equal(yield* issueStore.issueOwner(issue), successorTask.event.payload.childThreadId);
      assert.deepEqual(
        (yield* threads.getThreadProjection(child.thread.id)).thread.lineage,
        child.thread.lineage,
      );
      assert.equal((yield* threads.getThreadProjection(root.thread.id)).subagents.length, 2);
      // A follow-up to the former worker could never be admitted; it names the successor instead.
      const runsBefore = (yield* threads.getThreadRecords(child.thread.id, ["runs"])).runs.length;
      const refused = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("issue-worker:former-followup"),
          threadId: child.thread.id,
          messageId: MessageId.make("issue-worker:former-followup"),
          text: "Revise the fix",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.flip);
      assert.include(refused.message, successorTask.event.payload.childThreadId);
      assert.equal(
        (yield* threads.getThreadRecords(child.thread.id, ["runs"])).runs.length,
        runsBefore,
      );
    }).pipe(Effect.provide(testLayer));
  };

  it.effect(
    "panel starts create one child without a root turn, and retries cannot start another attempt",
    () => exercise("baseline"),
  );
  it.effect(
    "a directly resumed worker publishes one closeout and delivers one parent result per task",
    () => exercise("direct-resume"),
  );
  it.effect(
    "deleting a waiting worker publishes Unavailable and drops an older queued status",
    () => exercise("deletion"),
  );
});

it.effect(
  "shares four slots across a nested issue tree, guards parents and eligibility, queues resumes, pauses admission, and wakes the root on completion",
  () => {
    const issue = (number: number) => ({
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:milestone",
      id: `issue:${number}`,
      nodeId: `node:${number}`,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/tannerpolley/t3code/issues/${number}`,
    });
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: issue(input.number),
        state: "open" as const,
        milestoneNumber: 1,
        parent: input.number === 4 ? issue(1) : null,
        subIssues: input.number === 1 ? [issue(4)] : [],
        blockedBy: input.number === 6 ? [{ issue: issue(99), state: "open" as const }] : [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: input.number !== 7,
      });
    const harness = makeHarness({
      runContinuationWorker: true,
      adapters: [adapter, { ...adapter, instanceId: ProviderInstanceId.make("codex-second") }],
      issueServiceLayer: Layer.mock(IssueService.IssueService)({ workRead }),
    });
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const rootId = ThreadId.make("milestone-root");
      const config = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        repositoryId: "repo:milestone",
        projectId,

        launchCommandId: CommandId.make("milestone-root-create"),
        revision: 1,
        paused: false,
        workerLimit: 4,
        publishStatusComments: true,
        publishCloseoutComments: true,
        milestones: [
          {
            number: 1,
            modelRoleId: "worker",

            status: "running" as const,
            fingerprint: "",
          },
        ],
        suspendedIssues: [],
      };
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
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("milestone-root-start"),
        threadId: rootId,
        messageId: MessageId.make("milestone-root-start"),
        text: "Work through milestone 1",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const delegate = (
        number: number,
        parentThreadId = rootId,
        key = `milestone-delegate:${number}`,
        withWorktree = false,
      ) =>
        Effect.gen(function* () {
          const projection = yield* threads.getThreadRecords(parentThreadId, ["runs"]);
          const run = projection.runs.findLast((entry) =>
            ["starting", "running", "waiting"].includes(entry.status),
          )!;
          const result = yield* threads.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(key),
            parentThreadId,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            issue: issue(number),
            task: `Finish issue ${number}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            ...(withWorktree
              ? {
                  workspaceStrategy: {
                    type: "worktree" as const,
                    baseRef: "main",
                    branch: "issue-worker",
                  },
                }
              : {}),
            createdBy: "agent",
            creationSource: "mcp",
          });
          const created = result.storedEvents.find(
            (stored) => stored.event.type === "thread.created",
          );
          if (created?.event.type !== "thread.created")
            return yield* Effect.die("No worker created");
          return created.event.threadId;
        });
      const first = yield* delegate(1);
      const second = yield* delegate(2);
      const third = yield* delegate(3);
      assert.equal(
        (yield* delegate(4, rootId, "wrong-parent").pipe(Effect.result))._tag,
        "Failure",
      );
      const waitingRun = (yield* threads.getThreadRecords(first, ["runs"])).runs[0]!;
      const questionAt = yield* DateTime.now;
      const question: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("milestone-question"),
        nodeId: waitingRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "milestone-question",
          strength: "strong",
        },
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: questionAt,
        resolvedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("milestone-question"),
            type: "runtime-request.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: question,
          },
          {
            id: EventId.make("milestone-waiting"),
            type: "run.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: { ...waitingRun, status: "waiting" },
          },
        ],
      });
      const [nested, fifth] = yield* Effect.all([delegate(4, first), delegate(5)], {
        concurrency: 2,
      });
      assert.equal(
        (yield* threads.getThreadRecords(nested, [])).thread.lineage.parentThreadId,
        first,
      );
      const status = (id: ThreadId) =>
        threads
          .getThreadRecords(id, ["runs"])
          .pipe(Effect.map((projection) => projection.runs.at(-1)!.status));
      assert.deepEqual([yield* status(nested), yield* status(fifth)].sort(), [
        "queued",
        "starting",
      ]);
      const queued = (yield* status(nested)) === "queued" ? nested : fifth;
      const sql = yield* SqlClient.SqlClient;
      const starts = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${queued} AND effect_type = 'provider-turn.start'`;
      assert.equal(starts.length, 0);
      assert.equal((yield* delegate(6).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* delegate(7).pipe(Effect.result))._tag, "Failure");
      const finish = (id: ThreadId, key: string) =>
        Effect.gen(function* () {
          const run = (yield* threads.getThreadRecords(id, ["runs"])).runs.findLast(
            (entry) => entry.status !== "queued",
          )!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${key}:result`),
                type: "message.updated",
                threadId: id,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`${key}:result`),
                  threadId: id,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  role: "assistant",
                  text: "Finished.",
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
                threadId: id,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        });
      const waitForStart = (id: ThreadId, sequence: number) =>
        sink.stream({ afterSequence: sequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === id &&
              stored.event.type === "run.updated" &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      assert.equal(yield* status(first), "waiting");
      yield* sink.write({
        events: [
          {
            id: EventId.make("milestone-answer"),
            type: "runtime-request.updated",
            threadId: first,
            runId: waitingRun.id,
            occurredAt: questionAt,
            payload: { ...question, status: "resolved", resolvedAt: questionAt },
          },
        ],
      });
      const beforeFirstFinish = yield* sink.latestSequence();
      yield* finish(first, "parent-turn-ended");
      yield* waitForStart(queued, beforeFirstFinish);
      assert.equal(yield* status(queued), "starting");
      // The parent owns unfinished nested work, but its completed turn released its slot.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-resume"),
        threadId: first,
        messageId: MessageId.make("parent-resume"),
        text: "Continue",
        attachments: [],
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("codex-second") },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(yield* status(first), "queued");
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make("pause-plan"),
        threadId: rootId,
        expectedRevision: 1,
        orchestration: { ...config, paused: true },
      });
      yield* finish(rootId, "root-waits");
      const beforeLeafFinish = yield* sink.latestSequence();
      yield* finish(second, "second-done");
      yield* sink.stream({ afterSequence: beforeLeafFinish, eventType: "run.created" }).pipe(
        Stream.filter((stored) => stored.event.threadId === rootId),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* threads.dispatch({
        type: "queue.resume",
        threadId: first,
        commandId: CommandId.make("resume-while-paused"),
      });
      assert.equal(yield* status(first), "queued");
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make("resume-plan"),
        threadId: rootId,
        expectedRevision: 2,
        orchestration: { ...config, revision: 2, paused: false },
      });
      yield* threads.dispatch({
        type: "queue.resume",
        threadId: first,
        commandId: CommandId.make("resume-after-pause"),
      });
      assert.equal(yield* status(first), "starting");
      const preparingWorker = yield* delegate(8, rootId, "worktree-worker", true);
      assert.equal(yield* status(preparingWorker), "queued");
      const beforePreparation = yield* sink.latestSequence();
      yield* finish(third, "release-preparation-slot");
      yield* sink.stream({ afterSequence: beforePreparation, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.threadId === preparingWorker &&
            stored.event.type === "run.updated" &&
            stored.event.payload.status === "preparing",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const preparing = (yield* threads.getThreadRecords(preparingWorker, ["runs"])).runs[0]!;
      const failedAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("workspace-preparation-failed"),
            type: "run.updated",
            threadId: preparingWorker,
            runId: preparing.id,
            occurredAt: failedAt,
            payload: { ...preparing, status: "failed", completedAt: failedAt },
          },
        ],
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("worktree-provider-resume"),
        threadId: preparingWorker,
        messageId: MessageId.make("worktree-provider-resume"),
        text: "Retry using the other provider instance",
        attachments: [],
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("codex-second") },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const resumedPreparation = (yield* threads.getThreadRecords(preparingWorker, [
        "runs",
      ])).runs.at(-1)!;
      assert.equal(resumedPreparation.status, "preparing");
      assert.equal(resumedPreparation.workspacePreparation?.type, "worktree");
      const prematureStarts =
        yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${preparingWorker} AND effect_type = 'provider-turn.start'`;
      assert.equal(prematureStarts.length, 0);
      const root = yield* threads.getThreadRecords(rootId, ["runs", "messages"]);
      assert.isTrue(root.runs.length > 1);
      assert.isTrue(
        root.messages.some(
          (message) =>
            message.notification !== undefined || message.delegatedCompletion !== undefined,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "starts ancestor owners for milestone work, reports blocked and unreadable plans, and suspends externally changed branches without rewriting lineage",
  () => {
    const linked = (number: number) => ({
      host: "github.com",
      repository: "tannerpolley/t3code",
      repositoryId: "repo:plans",
      id: `issue:${number}`,
      nodeId: `node:${number}`,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/tannerpolley/t3code/issues/${number}`,
    });
    let newBlocker = false;
    let reparented = false;
    const milestoneNumber = (number: number) =>
      number <= 2 ? 1 : number === 3 ? 2 : number === 4 ? 3 : number === 5 ? 4 : 6;
    const summary = (number: number) => ({
      number,
      title: `Issue ${number}`,
      url: linked(number).url,
      state: "open" as const,
      stateReason: null,
      author: null,
      assignees: [],
      labels: [],
      milestone: {
        number: milestoneNumber(number),
        title: `Milestone ${milestoneNumber(number)}`,
        state: "open" as const,
        dueAt: null,
        url: "https://github.com/tannerpolley/t3code/milestone/1",
        openCount: 1,
        closedCount: 0,
      },
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
      commentCount: 0,
    });
    const workRead = (input: { number: number }) =>
      Effect.succeed({
        issue: linked(input.number),
        state: "open" as const,
        milestoneNumber: milestoneNumber(input.number),
        parent:
          input.number === 2 && !reparented ? linked(1) : input.number === 3 ? linked(9) : null,
        subIssues: input.number === 1 ? [linked(2)] : [],
        blockedBy:
          input.number === 4 || (input.number === 2 && newBlocker)
            ? [{ issue: linked(99), state: "open" as const }]
            : [],
        parentComplete: true,
        subIssuesComplete: true,
        blockersComplete: input.number !== 5,
      });
    const reads = Layer.mock(IssueService.IssueService)({
      workRead,
      repositoryIdentity: () =>
        Effect.succeed({
          host: "github.com",
          repository: "tannerpolley/t3code",
          repositoryId: "repo:plans",
        }),
      milestoneIssues: (input) =>
        Effect.succeed({
          issues: [1, 2, 3, 4, 5]
            .map(summary)
            .filter((issue) => issue.milestone.number === input.milestoneNumber),
          complete: true,
        }),
      detail: (input) =>
        Effect.succeed({
          repository: { host: "github.com", repository: "tannerpolley/t3code" },
          viewer: null,
          fetchedAt: "2026-10-05T00:00:00Z",
          issue: summary(input.number),
          body: "Finish this issue",
          comments: [],
          linkedPullRequests: [],
        }),
      resolveLinkedIssue: (input) => Effect.succeed(linked(input.number)),
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
    const harness = makeHarness({
      issueServiceLayer: reads,
      localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
      hasCommit: () => Effect.succeed(true),
      providers: [provider],
      projectRepositoryIdentity: {
        canonicalKey: "github.com/tannerpolley/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/tannerpolley/t3code.git",
        },
        provider: "github",
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
    });
    const dependencies = Layer.mergeAll(
      harness.layer,
      reads,
      IssueWorkStore.layer.pipe(Layer.provide(harness.layer)),
      IdAllocator.layer,
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
    );
    const serviceLayer = IssueWorkService.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        host: "github.com",
        repository: "tannerpolley/t3code",
        projectId,
        modelRoleId: "worker",
      };
      const emptyPlan = yield* service.workMilestone({
        ...input,
        milestoneNumber: 5,
        clientRequestId: CommandId.make("empty-plan"),
      });
      assert.isNotNull(emptyPlan.rootThreadId);
      assert.equal(emptyPlan.orchestration?.milestones[0]?.status, "complete");
      const plan = yield* service.workMilestone({
        ...input,
        milestoneNumber: 1,
        clientRequestId: CommandId.make("plan:1"),
      });
      const rootId = plan.rootThreadId!;
      const root = yield* threads.getThreadRecords(rootId, ["runs", "messages", "subagents"]);
      assert.lengthOf(root.messages, 0);
      assert.lengthOf(root.runs, 0);
      assert.lengthOf(root.subagents, 1);
      const store = yield* IssueWorkStore.IssueWorkStore;
      const firstId = (yield* store.issueOwner(linked(1)))!;
      const secondId = (yield* store.issueOwner(linked(2)))!;
      yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker).stream(firstId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      assert.equal(
        (yield* threads.getThreadRecords(firstId, ["runs"])).runs[0]!.status,
        "starting",
      );
      assert.equal(
        (yield* threads.getThreadRecords(secondId, [])).thread.lineage.parentThreadId,
        firstId,
      );
      newBlocker = true;
      yield* service.reconcile(rootId);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      let state = yield* service.repositoryStatus(input);
      assert.isTrue(
        state.orchestration!.suspendedIssues.some(
          (entry) => entry.id === "issue:2" && entry.reason.includes("blocker"),
        ),
      );
      assert.equal(
        (yield* threads.getThreadRecords(secondId, ["runs"])).runs[0]?.status,
        "interrupted",
      );
      newBlocker = false;
      yield* service.setPaused({
        ...input,
        paused: false,
        clientRequestId: CommandId.make("plan:resume-after-blocker"),
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: secondId,
        commandId: CommandId.make("plan:worker-resume"),
        messageId: MessageId.make("plan:worker-resume"),
        text: "Resume the issue",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      reparented = true;
      yield* service.setPaused({
        ...input,
        paused: true,
        clientRequestId: CommandId.make("plan:pause"),
      });
      assert.isTrue((yield* service.repositoryStatus(input)).orchestration!.paused);
      yield* service.setPaused({
        ...input,
        paused: false,
        clientRequestId: CommandId.make("plan:resume"),
      });
      state = yield* service.repositoryStatus(input);
      assert.isTrue(
        state.orchestration!.suspendedIssues.some(
          (entry) => entry.id === "issue:2" && entry.reason.includes("re-parented"),
        ),
      );
      assert.equal(
        (yield* threads.getThreadRecords(secondId, [])).thread.lineage.parentThreadId,
        firstId,
      );
      for (const [number, status] of [
        [2, "awaiting_approval"],
        [3, "blocked"],
        [4, "unreadable"],
        [5, "complete"],
      ] as const) {
        const result = yield* service.workMilestone({
          ...input,
          milestoneNumber: number,
          clientRequestId: CommandId.make(`plan:${number}`),
        });
        assert.equal(
          result.orchestration!.milestones.find((entry) => entry.number === number)?.status,
          status,
        );
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(dependencies, serviceLayer, suspensionWorkerLayer(dependencies)),
      ),
    );
  },
);

it.effect.each(["reactor-first", "retry-first"] as const)(
  "preparation recovery reuses one recorded worktree when %s wins",
  (order) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const allowSetup = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = makeHarness({
        runSetup: () =>
          ++attempts === 1
            ? Effect.fail(new Error("setup failed") as never)
            : Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(allowSetup)),
                Effect.as({ status: "no-script" as const }),
              ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const input = launchInput({
          command: `race:${order}`,
          thread: `race:${order}`,
          message: "Prepare once",
          workspace: { type: "worktree", baseRef: "main" },
        });
        const launched = yield* launches.launch(input);
        yield* sink.stream({ threadId: launched.threadId, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* sink
          .stream({ threadId: launched.threadId, eventType: "thread.metadata-updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "thread.metadata-updated" &&
                stored.event.payload.branch === "generated-branch",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const failed = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(failed.thread.worktreePath, "/repo-worktrees/feature");
        const retry = {
          commandId: CommandId.make(`race:${order}:retry`),
          threadId: launched.threadId,
          runId: failed.runs[0]!.id,
        };
        const recover = launches.prepareRun(retry);
        if (order === "reactor-first") {
          yield* threads.dispatch({ type: "prepared-run.retry", ...retry });
          yield* recover;
          yield* Deferred.await(entered);
          yield* launches.retryPreparation(retry);
        } else {
          yield* launches.retryPreparation(retry);
          yield* Deferred.await(entered);
          yield* recover;
        }
        assert.equal(harness.createWorktree.mock.calls.length, 1);
        assert.equal(harness.renameBranch.mock.calls.length, 1);
        assert.equal(harness.runSetup.mock.calls.length, 2);
        yield* Deferred.succeed(allowSetup, undefined);
        yield* sink.stream({ threadId: launched.threadId, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) => stored.commandId === CommandId.make(`${retry.commandId}:release`),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const finished = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(finished.runs.length, 1);
        assert.equal(finished.runs[0]!.status, "starting");
        assert.equal(finished.thread.branch, failed.thread.branch);
        assert.equal(finished.thread.worktreePath, failed.thread.worktreePath);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "rejects an already-owned parent from another repository at start and delegation, and refuses mismatched lineage admission",
  () => {
    const parentIssue = reviewIssue(1, "owner/other");
    const childIssue = reviewIssue(2);
    const harness = reviewHarness((input) =>
      Effect.succeed({
        ...reviewRead(reviewIssue(input.number, input.repository)),
        parent: input.number === 2 ? parentIssue : null,
      }),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const otherRoot = yield* createReviewRoot("owner/other");
      const root = yield* createReviewRoot();
      const delegated = yield* delegateReviewIssue(otherRoot, parentIssue, "cross-parent");
      const owner = delegated.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.threadId;
      const start = yield* service
        .start({
          ...childIssue,
          projectId,
          modelRoleId: "worker",

          clientRequestId: CommandId.make("cross-start"),
        })
        .pipe(Effect.flip);
      assert.include(start.message, "approval to expand");
      const rejected = yield* delegateReviewIssue(owner, childIssue, "cross-delegate").pipe(
        Effect.flip,
      );
      assert.include(rejected.message, "approval to expand");
      assert.isNull(yield* store.issueOwner(childIssue));
      const now = yield* DateTime.now;
      const corruptId = ThreadId.make("cross-corrupt-history");
      const source = (yield* threads.getThreadRecords(owner, [])).thread;
      yield* sink.write({
        events: [
          {
            id: EventId.make("cross-corrupt-create"),
            type: "thread.created",
            threadId: corruptId,
            occurredAt: now,
            payload: {
              ...source,
              id: corruptId,
              linkedIssue: childIssue,
              lineage: { ...source.lineage, parentThreadId: owner },
            },
          },
        ],
      });
      assert.isFalse(yield* store.canAdmit(childIssue, corruptId));
      assert.notInclude(yield* store.workerThreads(root), corruptId);
      assert.notInclude(yield* store.workerThreads(otherRoot), corruptId);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "rejects unsupported adapters at managed start, delegation and provider changes while allowing Claude",
  () => {
    const harness = reviewHarness(
      (input) => Effect.succeed(reviewRead(reviewIssue(input.number, input.repository))),
      true,
    );
    return Effect.gen(function* () {
      const service = yield* IssueWorkService.IssueWorkService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const unsupported = { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" };
      const start = yield* service
        .start({
          ...reviewIssue(1),
          projectId,
          modelRoleId: "worker",

          clientRequestId: CommandId.make("unsupported-start"),
        })
        .pipe(Effect.flip);
      assert.include(start.message, "Codex or Claude");
      const root = yield* createReviewRoot();
      const directStart = yield* threads
        .dispatch({
          type: "issue.work.start",
          commandId: CommandId.make("unsupported-direct-start"),
          threadId: root,
          issue: reviewIssue(1),
          workerModelSelection: unsupported,

          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.include(directStart.message, "Codex or Claude");
      const rejected = yield* delegateReviewIssue(
        root,
        reviewIssue(1),
        "unsupported-delegate",
        unsupported,
      ).pipe(Effect.flip);
      assert.include(rejected.message, "Codex or Claude");
      const child = yield* delegateReviewIssue(root, reviewIssue(1), "claude-delegate", {
        instanceId: ProviderInstanceId.make("claude"),
        model: "test-model",
      });
      const childId = child.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.threadId;
      for (const threadId of [root, childId]) {
        const result = yield* threads
          .dispatch({
            type: "provider.switch",
            commandId: CommandId.make(`unsupported-switch:${threadId}`),
            threadId,
            modelSelection: unsupported,
          })
          .pipe(Effect.flip);
        assert.include(result.message, "Codex or Claude");
      }
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "GitHub relationship reads release command planning so interrupts can commit, and unknown reads never admit",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let hold = false;
      let unknown = false;
      const harness = reviewHarness((input) =>
        Effect.gen(function* () {
          if (hold) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(proceed);
          }
          return {
            ...reviewRead(reviewIssue(input.number, input.repository)),
            blockersComplete: !unknown,
          };
        }),
      );
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const root = yield* createReviewRoot();
        const rootRun = (yield* threads.getThreadRecords(root, ["runs"])).runs[0]!;
        const child = yield* delegateReviewIssue(root, reviewIssue(1), "io-first-child");
        const childId = child.storedEvents.find((stored) => stored.event.type === "thread.created")!
          .event.threadId;
        hold = true;
        const launch = yield* delegateReviewIssue(root, reviewIssue(2), "io-blocked-delegate").pipe(
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        const stop = yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("io-stop"),
          threadId: root,
          runId: rootRun.id,
        });
        assert.isTrue(
          stop.storedEvents.some(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "interrupted",
          ),
        );
        yield* Deferred.succeed(proceed, undefined);
        assert.equal((yield* Fiber.join(launch))._tag, "Failure");
        hold = false;
        unknown = true;
        const childRun = (yield* threads.getThreadRecords(childId, ["runs"])).runs[0]!;
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("io-child-stop"),
          threadId: childId,
          runId: childRun.id,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("io-unknown-resume"),
          threadId: childId,
          messageId: MessageId.make("io-unknown-resume"),
          text: "Resume",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const runs = (yield* threads.getThreadRecords(childId, ["runs"])).runs;
        assert.equal(runs.at(-1)!.status, "queued");
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "re-parenting durably interrupts the existing branch and retries a failed suspension without losing its decision or lineage",
  () => {
    let reparented = false;
    let failures = 2;
    let failingThread: ThreadId | undefined;
    const harness = reviewHarness(
      (input) =>
        Effect.succeed({
          ...reviewRead(reviewIssue(input.number, input.repository)),
          parent:
            input.number === 3
              ? reviewIssue(2)
              : input.number === 2 && !reparented
                ? reviewIssue(1)
                : null,
        }),
      false,
      (threadId) => threadId === failingThread && failures-- > 0,
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const root = yield* createReviewRoot();
      const ids: ThreadId[] = [];
      let parent = root;
      for (const number of [1, 2, 3]) {
        const result = yield* delegateReviewIssue(
          parent,
          reviewIssue(number),
          `suspend-child:${number}`,
        );
        parent = result.storedEvents.find((stored) => stored.event.type === "thread.created")!.event
          .threadId;
        ids.push(parent);
      }
      const before = (yield* threads.getThreadRecords(ids[2]!, [])).thread;
      failingThread = ids[1];
      reparented = true;
      yield* service.reconcile(root);
      const suspended = (yield* store.configuration(root))!;
      assert.isTrue(
        suspended.suspendedIssues.some(
          (entry) => entry.id === reviewIssue(2).id && entry.reason.includes("re-parented"),
        ),
      );
      const actions = yield* sql<{
        effect_type: string;
        status: string;
      }>`SELECT effect_type, status FROM orchestration_v2_effect_outbox WHERE effect_type LIKE 'issue.suspension.%'`;
      assert.equal(actions.length, 3);
      assert.isTrue(actions.every((row) => row.status === "pending"));
      yield* worker.drain();
      const pending = yield* sql<{
        status: string;
        attempt_count: number;
      }>`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_type = 'issue.suspension.interrupt' AND thread_id = ${ids[1]!}`;
      assert.deepEqual(pending, [{ status: "pending", attempt_count: 1 }]);
      yield* service.reconcile(root); // Equal suspension reason still has durable work to finish.
      yield* TestClock.adjust("100 millis");
      yield* worker.drain();
      yield* TestClock.adjust("200 millis");
      yield* worker.drain();
      for (const id of ids.slice(1))
        assert.equal(
          (yield* threads.getThreadRecords(id, ["runs"])).runs[0]!.status,
          "interrupted",
        );
      const after = (yield* threads.getThreadRecords(ids[2]!, [])).thread;
      assert.deepEqual(after.lineage, before.lineage);
      assert.deepEqual(after.linkedIssue, before.linkedIssue);
      assert.isFalse(yield* store.canAdmit(reviewIssue(3), ids[2]!));
      const decisions = (yield* threads.getThreadRecords(root, ["messages"])).messages.filter(
        (message) => message.text.includes("paused:") && message.text.includes("re-parented"),
      );
      assert.equal(decisions.length, 1);
      const done = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type LIKE 'issue.suspension.%'`;
      assert.isTrue(done.every((row) => row.status === "succeeded"));
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "resumes only blocker-suspended workers once, retains other suspensions, and survives notification replay",
  () => {
    let blocked = false;
    let unreadable = false;
    const harness = reviewHarness((input) =>
      Effect.succeed({
        ...reviewRead(reviewIssue(input.number)),
        blockedBy:
          input.number === 1 && blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
        blockersComplete: input.number !== 2 || !unreadable,
      }),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* createReviewRoot();
      for (const number of [1, 2])
        yield* delegateReviewIssue(root, reviewIssue(number), `blocker-worker:${number}`);
      const child = (yield* store.issueOwner(reviewIssue(1)))!;
      const other = (yield* store.issueOwner(reviewIssue(2)))!;
      const before = (yield* threads.getThreadRecords(child, ["runs"])).thread;
      blocked = true;
      unreadable = true;
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.equal(
        (yield* threads.getThreadRecords(child, ["runs"])).runs[0]!.status,
        "interrupted",
      );
      yield* (yield* EventSink.EventSinkV2).stream({ eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.childThreadId === child &&
            stored.event.payload.result !== null,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const suspensions = (yield* store.configuration(root))!.suspendedIssues;
      assert.lengthOf(suspensions, 2);
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 1);
      const pauseNotice = (yield* threads.getThreadRecords(root, ["messages"])).messages.find(
        (message) => message.text.startsWith("Issue #1 paused:"),
      )!;
      assert.include(pauseNotice.text, "resumes automatically");
      assert.notInclude(pauseNotice.text, "Ask through t3_request_user_input");
      const otherNotice = (yield* threads.getThreadRecords(root, ["messages"])).messages.find(
        (message) => message.text.startsWith("Issue #2 paused:"),
      )!;
      assert.include(otherNotice.text, "Ask through t3_request_user_input");

      blocked = false;
      unreadable = false;
      const beforeResume = (yield* store.configuration(root))!;
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, [
        suspensions.find((entry) => entry.id === reviewIssue(2).id)!,
      ]);
      const resumed = yield* threads.getThreadRecords(child, ["runs", "messages"]);
      assert.lengthOf(resumed.runs, 2);
      assert.equal(resumed.runs.at(-1)!.status, "starting");
      assert.isDefined(resumed.runs.at(-1)!.delegatedTaskId);
      assert.deepEqual(resumed.thread.lineage, before.lineage);
      assert.equal(resumed.thread.worktreePath, before.worktreePath);
      assert.lengthOf(
        resumed.messages.filter((message) => message.text.includes("GitHub blockers are closed")),
        1,
      );
      assert.lengthOf((yield* threads.getThreadRecords(other, ["runs"])).runs, 1);
      const rootState = yield* threads.getThreadRecords(root, ["messages", "subagents"]);
      assert.isTrue(
        rootState.subagents.some((task) => task.id === resumed.runs.at(-1)!.delegatedTaskId),
      );
      assert.lengthOf(
        rootState.messages.filter(
          (message) => message.text === "Issue #1 resumed: its GitHub blockers are closed.",
        ),
        1,
      );
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make(
          `issue-resume:${root}:${beforeResume.revision}:${reviewIssue(1).id}`,
        ),
        threadId: root,
        expectedRevision: beforeResume.revision,
        orchestration: {
          ...beforeResume,
          suspendedIssues: beforeResume.suspendedIssues.filter(
            (entry) => entry.id !== reviewIssue(1).id,
          ),
        },
        resumeBlockedIssueId: reviewIssue(1).id,
      });

      // Simulate process loss after the notice committed but before the outbox acknowledged it.
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running'
        WHERE effect_type = 'issue.suspension.notify' AND effect_id LIKE '%issue-resumed:%'`;
      yield* outbox.reconcileAfterProcessLoss;
      yield* worker.drain();
      yield* service.reconcile(root);
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 2);
      assert.lengthOf(
        (yield* threads.getThreadRecords(root, ["messages"])).messages.filter((message) =>
          message.text.startsWith("Issue #1 resumed:"),
        ),
        1,
      );

      blocked = true;
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.equal(
        (yield* threads.getThreadRecords(child, ["runs"])).runs.at(-1)!.status,
        "interrupted",
      );
      blocked = false;
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 3);
      assert.lengthOf(
        (yield* threads.getThreadRecords(root, ["messages"])).messages.filter((message) =>
          message.text.startsWith("Issue #1 resumed:"),
        ),
        2,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("periodic root selection retains a blocker suspension without milestone work", () => {
  let blocked = false;
  const harness = reviewHarness((input) =>
    Effect.succeed({
      ...reviewRead(reviewIssue(input.number)),
      blockedBy: blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
    }),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const service = yield* IssueWorkService.IssueWorkService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = yield* createReviewRoot();
    const initial = (yield* store.configuration(root))!;
    yield* threads.dispatch({
      type: "repository.work.update",
      commandId: CommandId.make("single-issue-without-milestones"),
      threadId: root,
      expectedRevision: initial.revision,
      orchestration: { ...initial, milestones: [] },
    });
    yield* delegateReviewIssue(root, reviewIssue(1), "periodic-blocker-worker");
    const child = (yield* store.issueOwner(reviewIssue(1)))!;
    blocked = true;
    yield* service.reconcile(root);
    yield* worker.drain();
    assert.equal((yield* threads.getThreadRecords(child, ["runs"])).runs[0]!.status, "interrupted");
    assert.deepEqual(yield* store.activeRoots(), [root]);

    for (const paused of [true, false]) {
      const config = (yield* store.configuration(root))!;
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make(`periodic-root-paused:${paused}`),
        threadId: root,
        expectedRevision: config.revision,
        orchestration: { ...config, paused },
      });
      assert.deepEqual(yield* store.activeRoots(), paused ? [] : [root]);
    }

    blocked = false;
    for (const selected of yield* store.activeRoots()) yield* service.reconcile(selected);
    yield* worker.drain();
    assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, []);
    const runs = (yield* threads.getThreadRecords(child, ["runs"])).runs;
    assert.lengthOf(runs, 2);
    assert.equal(runs.at(-1)!.status, "starting");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps an unreadable suspension when access returns with an open blocker", () => {
  let unreadable = false;
  let blocked = false;
  const harness = reviewHarness((input) =>
    Effect.succeed({
      ...reviewRead(reviewIssue(input.number)),
      blockersComplete: !unreadable,
      blockedBy: blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
    }),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const service = yield* IssueWorkService.IssueWorkService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = yield* createReviewRoot();
    yield* delegateReviewIssue(root, reviewIssue(1), "unreadable-before-blocker");
    const child = (yield* store.issueOwner(reviewIssue(1)))!;
    unreadable = true;
    yield* service.reconcile(root);
    const original = (yield* store.configuration(root))!.suspendedIssues;
    assert.include(original[0]!.reason, "unreadable");

    // Access recovers before the durable interrupt has run.
    unreadable = false;
    blocked = true;
    yield* service.reconcile(root);
    assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, original);
    yield* worker.drain();
    blocked = false;
    yield* service.reconcile(root);
    yield* worker.drain();
    assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, original);
    assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 1);
    assert.isFalse(yield* store.canAdmit(reviewIssue(1), child));
    assert.isFalse(
      (yield* threads.getThreadRecords(root, ["messages"])).messages.some((message) =>
        message.text.startsWith("Issue #1 resumed:"),
      ),
    );

    yield* service.setPaused({
      host: "github.com",
      repository: "tannerpolley/t3code",
      paused: false,
      clientRequestId: CommandId.make("explicitly-clear-unreadable-suspension"),
    });
    assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, []);
    assert.isTrue(yield* store.canAdmit(reviewIssue(1), child));
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "does not announce a resumed worker that finished before the suspension interrupt",
  () => {
    let blocked = false;
    const harness = reviewHarness((input) =>
      Effect.succeed({
        ...reviewRead(reviewIssue(input.number)),
        blockedBy: blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
      }),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* createReviewRoot();
      yield* delegateReviewIssue(root, reviewIssue(1), "finished-before-interrupt");
      const child = (yield* store.issueOwner(reviewIssue(1)))!;
      blocked = true;
      yield* service.reconcile(root);
      const run = (yield* threads.getThreadRecords(child, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("blocker-worker-finished-before-interrupt"),
            type: "run.updated",
            threadId: child,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* worker.drain();
      blocked = false;
      yield* service.reconcile(root);
      yield* worker.drain();
      assert.deepEqual((yield* store.configuration(root))!.suspendedIssues, []);
      const final = yield* threads.getThreadRecords(child, ["runs", "messages"]);
      assert.lengthOf(final.runs, 1);
      assert.equal(final.runs[0]!.status, "completed");
      assert.isFalse(
        final.messages.some((message) => message.text.includes("GitHub blockers are closed")),
      );
      assert.isFalse(
        (yield* threads.getThreadRecords(root, ["messages"])).messages.some((message) =>
          message.text.startsWith("Issue #1 resumed:"),
        ),
      );
      assert.isEmpty(
        yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'issue.suspension.notify' AND json_extract(payload_json, '$.resumed') = 1`,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("queues a blocker continuation behind the repository worker limit", () => {
  let blocked = false;
  const harness = reviewHarness((input) =>
    Effect.succeed({
      ...reviewRead(reviewIssue(input.number)),
      blockedBy:
        input.number === 1 && blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
    }),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const service = yield* IssueWorkService.IssueWorkService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = yield* createReviewRoot();
    yield* delegateReviewIssue(root, reviewIssue(1), "capacity-blocked-worker");
    const child = (yield* store.issueOwner(reviewIssue(1)))!;
    blocked = true;
    yield* service.reconcile(root);
    yield* worker.drain();
    const config = (yield* store.configuration(root))!;
    yield* threads.dispatch({
      type: "repository.work.update",
      commandId: CommandId.make("blocker-worker-limit"),
      threadId: root,
      expectedRevision: config.revision,
      orchestration: { ...config, workerLimit: 1 },
    });
    yield* delegateReviewIssue(root, reviewIssue(2), "capacity-occupied-worker");
    const occupied = (yield* store.issueOwner(reviewIssue(2)))!;
    blocked = false;
    yield* service.reconcile(root);
    yield* worker.drain();
    const continuation = (yield* threads.getThreadRecords(child, ["runs"])).runs.at(-1)!;
    assert.equal(continuation.status, "queued");
    assert.equal(yield* store.slotsInUse(root), 1);
    yield* service.reconcile(root);
    assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 2);
    const active = (yield* threads.getThreadRecords(occupied, ["runs"])).runs[0]!;
    yield* threads.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("release-blocker-worker-slot"),
      threadId: occupied,
      runId: active.id,
    });
    yield* service.reconcile(root);
    yield* worker.drain();
    const admitted = (yield* threads.getThreadRecords(child, ["runs"])).runs.at(-1)!;
    assert.equal(admitted.id, continuation.id);
    assert.equal(admitted.status, "starting");
    assert.equal(yield* store.slotsInUse(root), 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retains the continuation when a blocker closes before its interrupt effect runs", () => {
  let blocked = false;
  const harness = reviewHarness((input) =>
    Effect.succeed({
      ...reviewRead(reviewIssue(input.number)),
      blockedBy: blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
    }),
  );
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const service = yield* IssueWorkService.IssueWorkService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = yield* createReviewRoot();
    yield* delegateReviewIssue(root, reviewIssue(1), "fast-blocker-worker");
    const child = (yield* store.issueOwner(reviewIssue(1)))!;
    blocked = true;
    yield* service.reconcile(root);
    blocked = false;
    yield* service.reconcile(root);
    const pending = yield* threads.getThreadRecords(child, ["runs"]);
    assert.lengthOf(pending.runs, 2);
    assert.equal(pending.runs.at(-1)!.status, "queued");
    yield* worker.drain();
    yield* service.reconcile(root);
    const resumed = yield* threads.getThreadRecords(child, ["runs"]);
    assert.equal(resumed.runs[0]!.status, "interrupted");
    assert.equal(resumed.runs.at(-1)!.status, "starting");
    assert.equal(resumed.runs.at(-1)!.id, pending.runs.at(-1)!.id);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["paused", "draining"] as const)(
  "does not auto-resume a blocker-suspended worker while the repository is %s",
  (stopped) => {
    let blocked = false;
    const harness = reviewHarness((input) =>
      Effect.succeed({
        ...reviewRead(reviewIssue(input.number)),
        blockedBy: blocked ? [{ issue: reviewIssue(99), state: "open" as const }] : [],
      }),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IssueWorkService.IssueWorkService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const root = yield* createReviewRoot();
      yield* delegateReviewIssue(root, reviewIssue(1), `stopped-worker:${stopped}`);
      const child = (yield* store.issueOwner(reviewIssue(1)))!;
      blocked = true;
      yield* service.reconcile(root);
      yield* worker.drain();
      const config = (yield* store.configuration(root))!;
      yield* threads.dispatch({
        type: "repository.work.update",
        commandId: CommandId.make(`stop-repository:${stopped}`),
        threadId: root,
        expectedRevision: config.revision,
        orchestration: {
          ...config,
          paused: true,
          ...(stopped === "draining"
            ? {
                handoff: {
                  requestId: CommandId.make("blocked-handoff"),
                  nextThreadId: ThreadId.make("blocked-handoff-next"),
                  summary: "Transfer repository work",
                  modelSelection,
                  status: "draining" as const,
                  wasPaused: false,
                },
              }
            : {}),
        },
      });
      blocked = false;
      yield* service.reconcile(root);
      yield* worker.drain();
      // A draining handoff may transfer ownership, but cannot restart the retained worker.
      assert.lengthOf((yield* threads.getThreadRecords(child, ["runs"])).runs, 1);
      assert.lengthOf(
        (yield* threads.getThreadRecords(root, ["messages"])).messages.filter((message) =>
          message.text.startsWith("Issue #1 resumed:"),
        ),
        0,
      );
      assert.lengthOf((yield* store.configuration(root))!.suspendedIssues, 1);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "a burst of worker preparation events continues locally without full GitHub reconciliations",
  () => {
    const workRead = vi.fn(
      (input: Parameters<IssueService.IssueService["Service"]["workRead"]>[0]) =>
        Effect.succeed(reviewRead(reviewIssue(input.number, input.repository))),
    );
    const harness = reviewHarness(workRead);
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const continued = new Map<string, Deferred.Deferred<void>>();
      const milestone = (key: string) => {
        if (!continued.has(key)) continued.set(key, Deferred.makeUnsafe<void>());
        return continued.get(key)!;
      };
      const dispatch = threads.dispatch;
      const tracked = vi
        .spyOn(threads, "dispatch")
        .mockImplementation((command) =>
          dispatch(command).pipe(
            Effect.tap(() =>
              command.type === "repository.work.continue"
                ? Deferred.succeed(milestone(String(command.commandId)), undefined)
                : Effect.void,
            ),
          ),
        );
      const root = yield* createReviewRoot();
      const child = yield* delegateReviewIssue(root, reviewIssue(1), "burst-child");
      const childId = child.storedEvents.find((stored) => stored.event.type === "thread.created")!
        .event.threadId;
      const run = (yield* threads.getThreadRecords(childId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      const before = workRead.mock.calls.length;
      const events = Array.from({ length: 24 }, (_, i) => ({
        id: EventId.make(`burst-prepare:${i}`),
        type: "run.updated" as const,
        threadId: childId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "preparing" as const },
      }));
      const committed = yield* sink.write({ events });
      const lastSequence = committed.at(-1)!.sequence;
      const config = (yield* (yield* IssueWorkStore.IssueWorkStore).configuration(root))!;
      yield* Deferred.await(
        milestone(`issue-admission:${root}:${config.revision}:event:${lastSequence}`),
      );
      tracked.mockRestore();
      assert.equal(yield* sink.latestSequence(), lastSequence);
      assert.equal(workRead.mock.calls.length - before, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);
