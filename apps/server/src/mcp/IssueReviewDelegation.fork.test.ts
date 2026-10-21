import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProviderSessionId,
  resolveThreadRole,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IssueLinks from "../issues/IssueLinks.ts";
import * as IssueWorkService from "../issues/IssueWorkService.ts";
import * as IssueWorkStore from "../issues/IssueWorkStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { continueRestartedRun } from "../orchestration-v2/RestartContinuation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import {
  createReviewRoot,
  delegateReviewIssue,
  modelSelection,
  reviewHarness,
  reviewIssue,
  reviewRead,
} from "../orchestration-v2/ThreadLaunchService.testHarness.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

function setup() {
  let closed = false;
  const harness = reviewHarness((input) =>
    Effect.succeed({
      ...reviewRead(reviewIssue(input.number)),
      state: closed ? ("closed" as const) : ("open" as const),
    }),
  );
  const readDefaultBranch = vi.fn(() => Effect.succeed("main"));
  const dependencies = Layer.mergeAll(
    harness.layer,
    NodeServices.layer,
    IssueLinks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeServices.layer,
          ProjectionStore.layer.pipe(Layer.provide(harness.layer)),
        ),
      ),
    ),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolveCommit: () => Effect.succeed({ commitSha: "abc" } as never),
    }),
  );
  const launch = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    readDefaultBranch,
    prepareRun: () => Effect.void,
  });
  const services = Layer.mergeAll(
    dependencies,
    IssueWorkService.layer.pipe(Layer.provide(Layer.mergeAll(dependencies, launch))),
  );
  const mcp = OrchestratorMcpService.layer.pipe(Layer.provide(Layer.mergeAll(services, launch)));
  return {
    ...harness,
    readDefaultBranch,
    close: () => {
      closed = true;
    },
    layer: mcp.pipe(Layer.provideMerge(services)),
  };
}
const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "issue-67",
  thread: {
    threadId,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: ProviderSessionId.make("test"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

it.effect(
  "read-only roles delegate with full slots, share the checkout and only link their optional issue",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const work = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* createReviewRoot();
      const repository = { host: "github.com", repository: "tannerpolley/t3code" };
      yield* work.setWorkerLimit({
        ...repository,
        workerLimit: 1,
        expectedRevision: 1,
        clientRequestId: CommandId.make("limit"),
      });
      yield* delegateReviewIssue(root, reviewIssue(1), "occupy-slot");
      assert.equal(yield* store.slotsInUse(root), 1);
      const originalOwner = yield* store.issueOwner(reviewIssue(1));
      const scope = scopeFor(root);
      let readOnlyRequests = 0;
      for (const role of ["checker", "reviewer", "investigator"] as const) {
        for (const issue of [undefined, reviewIssue(1)]) {
          const result = yield* mcp.delegateTask(scope, {
            role,
            task: "Read the diff",
            issue,
            clientRequestId: `${role}:${issue?.id ?? "no-issue"}`,
          });
          const child = yield* threads.getThreadRecords(result.childThreadId, ["runs"]);
          assert.equal(child.thread.worktreePath, null);
          assert.equal(child.thread.branch, null);
          assert.isUndefined(child.thread.linkedIssue);
          readOnlyRequests++;
          assert.equal(child.runs[0]!.status, readOnlyRequests <= 4 ? "starting" : "queued");
          assert.equal(result.status, readOnlyRequests <= 4 ? "running" : "queued");
          assert.equal(yield* store.readOnlySlotsInUse(root), Math.min(readOnlyRequests, 4));
          assert.isUndefined(child.runs[0]!.workspacePreparation);
          assert.equal(yield* store.slotsInUse(root), 1);
          assert.equal(yield* store.issueOwner(reviewIssue(1)), originalOwner);
          const links =
            yield* sql`SELECT thread_id FROM issue_thread_links WHERE thread_id = ${result.childThreadId}`;
          assert.lengthOf(links, issue === undefined ? 0 : 1);
        }
      }
      yield* work.queueIssue({
        ...repository,
        number: 3,
        clientRequestId: CommandId.make("queue-visible-review"),
      });
      const isolated = yield* mcp.delegateTask(scope, {
        role: "reviewer",
        issue: reviewIssue(3),
        task: "Review in isolation",
        isolation: "worktree",
        clientRequestId: "isolated-review",
      });
      const separate = yield* threads.getThreadRecords(isolated.childThreadId, ["runs"]);
      assert.equal(separate.runs[0]!.workspacePreparation?.type, "worktree");
      assert.isNull(yield* store.issueOwner(reviewIssue(3)));
      assert.equal((yield* store.queue(repository))[0]!.issue.id, reviewIssue(3).id);
      assert.equal(yield* store.slotsInUse(root), 1);
      assert.equal(harness.createWorktree.mock.calls.length, 0);
      assert.equal(harness.readDefaultBranch.mock.calls.length, 0);
      const missing = yield* mcp
        .delegateTask(scope, {
          role: "implementor",
          isolation: "shared",
          task: "Implement",
          clientRequestId: "no-issue",
        })
        .pipe(Effect.flip);
      assert.include(missing.message, "explicit issue");
      const worker = yield* mcp.delegateTask(scope, {
        role: "implementor",
        isolation: "shared",
        issue: reviewIssue(2),
        task: "Implement",
        clientRequestId: "queued-worker",
      });
      const queued = yield* threads.getThreadRecords(worker.childThreadId, ["runs", "turnItems"]);
      assert.equal(queued.runs[0]!.status, "queued");
      assert.equal(queued.runs[0]!.workspacePreparation?.type, "worktree");
      assert.equal(yield* store.issueOwner(reviewIssue(2)), worker.childThreadId);
      assert.equal(yield* store.slotsInUse(root), 1);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "cancelling a managed child queued for workspace preparation leaves it terminal and Resume keeps closed work clear",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const work = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const sink = yield* EventSink.EventSinkV2;
      const root = yield* createReviewRoot();
      const repository = { host: "github.com", repository: "tannerpolley/t3code" };
      yield* work.setWorkerLimit({
        ...repository,
        workerLimit: 1,
        expectedRevision: 1,
        clientRequestId: CommandId.make("limit"),
      });
      yield* delegateReviewIssue(root, reviewIssue(1), "occupy-slot");
      const scope = scopeFor(root);
      const child = yield* mcp.delegateTask(scope, {
        role: "implementor",
        issue: reviewIssue(2),
        task: "Implement",
        clientRequestId: "queued-cancel",
      });
      const before = yield* threads.getThreadRecords(child.childThreadId, ["turnItems"]);
      assert.isTrue(
        before.turnItems.some(
          (item) =>
            item.type === "command_execution" &&
            item.input === "Preparing workspace" &&
            item.status === "waiting",
        ),
      );
      const sequence = yield* sink.latestSequence();
      yield* mcp.cancelTask(scope, { taskId: child.taskId, clientRequestId: "cancel" });
      yield* sink.stream({ afterSequence: sequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === child.taskId &&
            stored.event.payload.status === "cancelled",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const status = yield* mcp.taskStatus(scope, child.taskId);
      assert.equal(status.status, "cancelled");
      assert.equal(status.workState, "result_available");
      const after = yield* threads.getThreadRecords(child.childThreadId, ["runs", "turnItems"]);
      assert.equal(after.runs[0]!.status, "cancelled");
      assert.isTrue(
        after.turnItems
          .filter(
            (item) => item.type === "command_execution" && item.input === "Preparing workspace",
          )
          .every((item) => item.status === "cancelled"),
      );
      // Recreate an attempt retained by an older build after the run was cancelled.
      const parentTask = (yield* threads.getThreadRecords(root, ["subagents"])).subagents.find(
        (task) => task.id === child.taskId,
      )!;
      const preparation = after.turnItems.find(
        (item) => item.type === "command_execution" && item.input === "Preparing workspace",
      )!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("legacy-cancelled-task"),
            type: "subagent.updated",
            threadId: root,
            nodeId: child.taskId,
            occurredAt: now,
            payload: { ...parentTask, status: "running", result: null, completedAt: null },
          },
          {
            id: EventId.make("legacy-waiting-preparation"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: { ...preparation, status: "waiting", completedAt: null },
          },
        ],
      });
      harness.close();
      yield* work.reconcile(root);
      assert.isTrue(
        (yield* store.configuration(root))!.suspendedIssues.some(
          (entry) => entry.id === reviewIssue(2).id,
        ),
      );
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      const config = (yield* store.configuration(root))!;
      yield* work.closeOut({
        ...repository,
        issueId: reviewIssue(2).id,
        expectedRevision: config.revision,
        clientRequestId: CommandId.make("close-legacy-attempt"),
      });
      const recovered = yield* threads.getThreadRecords(child.childThreadId, ["turnItems"]);
      assert.isFalse(
        recovered.turnItems.some(
          (item) =>
            item.type === "command_execution" &&
            item.input === "Preparing workspace" &&
            item.status === "waiting",
        ),
      );
      yield* work.setPaused({
        ...repository,
        paused: false,
        clientRequestId: CommandId.make("resume"),
      });
      assert.isFalse(
        (yield* store.configuration(root))!.suspendedIssues.some(
          (entry) => entry.id === reviewIssue(2).id,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "close-out requires the repository root and a closed, stopped attempt, clears suspension and survives Resume and retries",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const work = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const root = yield* createReviewRoot();
      yield* delegateReviewIssue(root, reviewIssue(1), "close-out-worker");
      const childId = (yield* store.issueOwner(reviewIssue(1)))!;
      const repository = { host: "github.com", repository: "tannerpolley/t3code" };
      const input = {
        ...repository,
        issueId: reviewIssue(1).id,
        expectedRevision: 1,
        clientRequestId: CommandId.make("close-out"),
      };
      const open = yield* work.closeOut(input).pipe(Effect.flip);
      assert.include(open.message, "confirmed closed");
      const denied = yield* mcp.closeOutIssue(scopeFor(childId), input).pipe(Effect.flip);
      assert.include(denied.message, "registered repository orchestrator");
      harness.close();
      const active = yield* work
        .closeOut({ ...input, clientRequestId: CommandId.make("active-close-out") })
        .pipe(Effect.flip);
      assert.include(active.message, "remaining work");
      yield* work.reconcile(root);
      assert.lengthOf((yield* store.configuration(root))!.suspendedIssues, 1);
      yield* worker.drain();
      // Suspension stops the worker; close-out explicitly finishes that retained attempt.
      const config = (yield* store.configuration(root))!;
      const stale = yield* work
        .closeOut({ ...input, clientRequestId: CommandId.make("stale-close-out") })
        .pipe(Effect.flip);
      assert.include(stale.message, "changed");
      const rejectedRetry = yield* work
        .closeOut({ ...input, clientRequestId: CommandId.make("active-close-out") })
        .pipe(Effect.flip);
      assert.include(rejectedRetry.message, "remaining work");
      const accepted = {
        ...input,
        expectedRevision: config.revision,
        clientRequestId: CommandId.make("finish-closed"),
      };
      const closed = yield* mcp.closeOutIssue(scopeFor(root), accepted);
      assert.lengthOf(closed.orchestration!.suspendedIssues, 0);
      assert.isTrue(yield* store.resultAvailable(childId));
      const parent = yield* threads.getThreadRecords(root, ["subagents"]);
      assert.equal(
        parent.subagents.find((task) => task.childThreadId === childId)!.status,
        "completed",
      );
      assert.deepEqual(yield* work.closeOut(accepted), closed);
      yield* work.setPaused({
        ...repository,
        paused: false,
        clientRequestId: CommandId.make("resume-closed"),
      });
      assert.lengthOf((yield* store.configuration(root))!.suspendedIssues, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "Resume does not re-suspend a finished implementor whose nested child was cancelled before its result was published",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const work = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const sink = yield* EventSink.EventSinkV2;
      const root = yield* createReviewRoot();
      yield* delegateReviewIssue(root, reviewIssue(1), "nested-owner");
      const owner = (yield* store.issueOwner(reviewIssue(1)))!;
      const child = yield* mcp.delegateTask(scopeFor(owner), {
        role: "checker",
        task: "Check",
        clientRequestId: "nested-checker",
      });
      const sequence = yield* sink.latestSequence();
      yield* mcp.cancelTask(scopeFor(owner), {
        taskId: child.taskId,
        clientRequestId: "cancel-nested",
      });
      yield* sink.stream({ afterSequence: sequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === child.taskId &&
            ["cancelled", "interrupted"].includes(stored.event.payload.status),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const run = (yield* threads.getThreadRecords(owner, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      // Seed the committed terminal run before its asynchronous parent-result projection catches up.
      yield* sink.write({
        events: [
          {
            id: EventId.make("terminal-before-parent-result"),
            type: "run.created",
            threadId: owner,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      assert.isFalse(yield* store.resultAvailable(owner));
      harness.close();
      const result = yield* work.setPaused({
        host: "github.com",
        repository: "tannerpolley/t3code",
        paused: false,
        clientRequestId: CommandId.make("resume-finished-owner"),
      });
      assert.isEmpty(result.orchestration!.suspendedIssues);
      const cancelled = (yield* threads.getThreadRecords(owner, ["subagents"])).subagents.find(
        (task) => task.id === child.taskId,
      )!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("cancelled-child-pending-delivery"),
            type: "subagent.updated",
            threadId: owner,
            nodeId: child.taskId,
            occurredAt: now,
            payload: {
              ...cancelled,
              completionDelivery: { state: "pending", observedByRunId: null },
            },
          },
        ],
      });
      yield* work.reconcile(root);
      const suspended = (yield* store.configuration(root))!;
      assert.lengthOf(suspended.suspendedIssues, 1);
      yield* work.closeOut({
        host: "github.com",
        repository: "tannerpolley/t3code",
        issueId: reviewIssue(1).id,
        expectedRevision: suspended.revision,
        clientRequestId: CommandId.make("finish-cancelled-child-owner"),
      });
      const finished = yield* threads.getThreadRecords(owner, ["subagents"]);
      assert.equal(
        finished.subagents.find((task) => task.id === child.taskId)!.completionDelivery?.state,
        "disposed",
      );
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      yield* work.setPaused({
        host: "github.com",
        repository: "tannerpolley/t3code",
        paused: false,
        clientRequestId: CommandId.make("resume-closed-cancelled-child-owner"),
      });
      assert.isEmpty((yield* store.configuration(root))!.suspendedIssues);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("read-only descendants cannot bypass managed admission for implementors", () => {
  const harness = setup();
  return Effect.gen(function* () {
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const work = yield* IssueWorkService.IssueWorkService;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const root = yield* createReviewRoot();
    yield* work.setWorkerLimit({
      host: "github.com",
      repository: "tannerpolley/t3code",
      workerLimit: 1,
      expectedRevision: 1,
      clientRequestId: CommandId.make("descendant-limit"),
    });
    yield* delegateReviewIssue(root, reviewIssue(1), "descendant-occupied-slot");
    let parent = root;
    for (const role of ["checker", "reviewer", "investigator"] as const) {
      const child = yield* mcp.delegateTask(scopeFor(parent), {
        role,
        task: "Read only",
        clientRequestId: `descendant-${role}`,
      });
      parent = child.childThreadId;
      const projection = yield* threads.getThreadRecords(parent, ["runs"]);
      assert.isUndefined(projection.thread.linkedIssue);
      assert.isUndefined(projection.thread.repositoryOrchestration);
      assert.equal(projection.runs[0]!.status, "starting");
      for (const implementationRole of [
        "implementor",
        "implementation",
        "general",
        undefined,
      ] as const) {
        const key = `${role}:${implementationRole ?? "default"}`;
        const missing = yield* mcp
          .delegateTask(scopeFor(parent), {
            role: implementationRole,
            isolation: "shared",
            task: "Implement without an issue",
            clientRequestId: `mcp-missing:${key}`,
          })
          .pipe(Effect.flip);
        assert.include(missing.message, "explicit issue");
        const run = projection.runs[0]!;
        const direct = yield* threads
          .dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(`direct-missing:${key}`),
            parentThreadId: parent,
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            role:
              implementationRole === undefined ? undefined : resolveThreadRole(implementationRole),
            task: "Implement without an issue",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.flip);
        assert.include(String(direct.cause), "explicit issue");
      }
      const wrongOwner = yield* mcp
        .delegateTask(scopeFor(parent), {
          role: "implementor",
          issue: reviewIssue(2),
          task: "Implement a top-level issue",
          clientRequestId: `wrong-owner:${role}`,
        })
        .pipe(Effect.flip);
      assert.include(wrongOwner.message, "immediate GitHub parent");
      assert.isNull(yield* store.issueOwner(reviewIssue(2)));
      assert.equal(yield* store.slotsInUse(root), 1);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "close-out refuses unsettled restart continuations and stays closed after they finish",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const work = yield* IssueWorkService.IssueWorkService;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const root = yield* createReviewRoot();
      yield* delegateReviewIssue(root, reviewIssue(1), "restart-worker");
      const child = (yield* store.issueOwner(reviewIssue(1)))!;
      const run = (yield* threads.getThreadRecords(child, ["runs"])).runs[0]!;
      yield* worker.drain();
      const now = yield* DateTime.now;
      const effectId = `effect:restart-continuation:${run.id}`;
      yield* sink.writeWithEffects({
        events: [
          {
            id: EventId.make("restart-cut"),
            type: "run.updated",
            threadId: child,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "cancelled", startedAt: now, completedAt: now },
          },
        ],
        effects: [
          {
            id: effectId,
            commandId: CommandId.make("restart-recovery"),
            threadId: child,
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          },
        ],
      });
      harness.close();
      const closeOut = Effect.fn("test.closeOutRestartAttempt")(function* (key: string) {
        const config = (yield* store.configuration(root))!;
        return yield* work.closeOut({
          host: "github.com",
          repository: "tannerpolley/t3code",
          issueId: reviewIssue(1).id,
          expectedRevision: config.revision,
          clientRequestId: CommandId.make(key),
        });
      });
      const pending = yield* closeOut("restart-close-pending").pipe(Effect.flip);
      assert.include(pending.message, "remaining work");
      assert.isFalse(yield* store.resultAvailable(child));
      const claimed = yield* outbox.claimNext({
        workerId: "restart-test",
        leaseDurationMs: 60_000,
        lane: "lifecycle",
      });
      assert.equal(Option.getOrThrow(claimed).id, effectId);
      const running = yield* closeOut("restart-close-running").pipe(Effect.flip);
      assert.include(running.message, "remaining work");
      // Stop reaches the cancelled source before the claimed continuation dispatches.
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-restart"),
        threadId: child,
      });
      const settings = yield* ServerSettingsService;
      const continueRun = continueRestartedRun({ threadId: child, sourceRunId: run.id }).pipe(
        Effect.provideService(ServerSettingsService, {
          ...settings,
          getSettings: settings.getSettings.pipe(
            Effect.map((value) => ({
              ...value,
              continueThreadsAfterServerUpdate: true,
            })),
          ),
        }),
      );
      yield* continueRun;
      assert.isTrue(yield* outbox.succeed({ effectId, workerId: "restart-test" }));
      yield* closeOut("restart-close-finished");
      assert.isTrue(yield* store.resultAvailable(child));
      yield* continueRun;
      yield* worker.drain();
      yield* work.reconcile(root);
      yield* work.setPaused({
        host: "github.com",
        repository: "tannerpolley/t3code",
        paused: false,
        clientRequestId: CommandId.make("resume-after-restart-close"),
      });
      const after = yield* threads.getThreadRecords(child, ["runs"]);
      assert.deepEqual(
        after.runs.map((row) => row.status),
        ["cancelled"],
      );
      assert.isEmpty((yield* store.configuration(root))!.suspendedIssues);
    }).pipe(Effect.provide(harness.layer));
  },
);
