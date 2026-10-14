import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "./ThreadLaunchService.testHarness.ts";

describe("delegate_task workspace", () => {
  const parentThreadId = ThreadId.make("thread:delegate-parent");
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:delegate"),
    requestNamespace: "provider-session:delegate",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:delegate",
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const codexProvider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    availability: "available",
    models: [],
    slashCommands: [],
    skills: [],
  };

  const withDelegatingParent = <A, E>(
    harness: ReturnType<typeof makeHarness>,
    body: (
      service: OrchestratorMcp.OrchestratorMcpService["Service"],
    ) => Effect.Effect<
      A,
      E,
      ThreadManagement.ThreadManagementService | WorktreeSetupTracker.WorktreeSetupTracker
    >,
    parentWorkspace: { readonly branch: string | null; readonly worktreePath: string | null } = {
      branch: "feature/parent",
      worktreePath: "/repo-worktrees/parent",
    },
  ) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      // A parent on its own branch and worktree, mid-turn, like an agent calling delegate_task.
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:delegate-parent:create"),
        threadId: parentThreadId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        ...parentWorkspace,
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegate-parent:message"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:delegate-parent"),
        text: "Split the work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      return yield* body(yield* OrchestratorMcp.OrchestratorMcpService);
    }).pipe(
      Effect.provide(
        OrchestratorMcp.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              harness.layer,
              ProviderAdapterRegistry.layerFromAdapters([adapter]),
              NodeCrypto.layer,
              Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
        ),
      ),
    );

  it.effect.each([
    { workspace: "worktree" },
    { role: "implementation" },
    { role: "implementor" },
    { role: "checker", workspace: "worktree" },
  ] as const)("prepares an isolated child before its first turn (%j)", (workspaceChoice) =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<string>();
      const allowSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        providers: [codexProvider],
        runSetup: (input) =>
          Deferred.succeed(setupEntered, input.worktreePath).pipe(
            Effect.andThen(Deferred.await(allowSetup)),
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* withDelegatingParent(harness, (service) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          const request = {
            task: "Implement the parser",
            title: "Parser",
            ...workspaceChoice,
            clientRequestId: "parser",
          } as const;
          const task = yield* service.delegateTask(scope, request);
          const created = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(created.runs[0]?.status, "preparing");

          // Setup runs in the bound worktree while the child's run still waits to start.
          assert.equal(yield* Deferred.await(setupEntered), "/repo-worktrees/feature");
          const worktree = harness.createWorktree.mock.calls[0]![0];
          assert.equal(worktree.cwd, "/repo");
          assert.equal(worktree.refName, "feature/parent");
          assert.match(worktree.newRefName ?? "", /^t3\/parser-[0-9a-f]{8}$/);
          const preparing = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(preparing.thread.worktreePath, "/repo-worktrees/feature");
          assert.equal(preparing.thread.branch, worktree.newRefName);
          assert.equal(preparing.runs[0]?.status, "preparing");

          // Retries with the same clientRequestId, during and after preparation, reuse it.
          assert.equal((yield* service.delegateTask(scope, request)).taskId, task.taskId);
          yield* Deferred.succeed(allowSetup, undefined);
          yield* tracker.stream(task.childThreadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
          const retried = yield* service.delegateTask(scope, request);
          assert.equal(retried.taskId, task.taskId);
          assert.equal(harness.createWorktree.mock.calls.length, 1);
          assert.equal(retried.worktreePath, "/repo-worktrees/feature");
          assert.equal(retried.branch, worktree.newRefName);
          const started = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(started.runs.length, 1);
          assert.equal(started.runs[0]?.status, "starting");
        }),
      );
    }),
  );

  it.effect.each([
    {},
    { role: "research" },
    { role: "review" },
    { role: "design" },
    { role: "test" },
    { role: "checker" },
    { role: "reviewer" },
    { role: "investigator" },
    { role: "orchestrator" },
    { role: "implementation", workspace: "inherit" },
    { role: "test", workspace: "inherit" },
  ] as const)("keeps a child in the parent's checkout (%j)", (workspaceChoice) => {
    const harness = makeHarness({ providers: [codexProvider] });
    return withDelegatingParent(harness, (service) =>
      Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const task = yield* service.delegateTask(scope, {
          task: "Review the parser",
          ...workspaceChoice,
        });
        assert.equal(task.branch, "feature/parent");
        assert.equal(task.worktreePath, "/repo-worktrees/parent");
        assert.equal(harness.createWorktree.mock.calls.length, 0);
        const child = yield* threads.getThreadProjection(task.childThreadId);
        assert.equal(child.runs[0]?.status, "starting");
      }),
    );
  });

  // A thread started in the project root records no branch; its checkout says where it is.
  const rootParent = { branch: null, worktreePath: null };
  const checkoutStatus = (refName: string | null) => ({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: refName === "main",
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  });
  const rootCheckoutStatus = (refName: string | null) => () =>
    Effect.succeed(checkoutStatus(refName));
  // A checkout whose status is cached until invalidated, like the git service's.
  const switchableCheckout = (initial: string | null) => {
    let head = initial;
    let cached: string | null | undefined;
    return {
      localStatus: () =>
        Effect.sync(() => {
          if (cached === undefined) cached = head;
          return checkoutStatus(cached);
        }),
      invalidateLocalStatus: () =>
        Effect.sync(() => {
          cached = undefined;
        }),
      switchTo: (refName: string | null) => {
        head = refName;
      },
    };
  };

  it.effect.each(["implementation", "implementor"] as const)(
    "cuts a root thread's %s child from the branch its checkout is on",
    (role) => {
      const harness = makeHarness({
        providers: [codexProvider],
        localStatus: rootCheckoutStatus("main"),
      });
      return withDelegatingParent(
        harness,
        (service) =>
          Effect.gen(function* () {
            const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
            const task = yield* service.delegateTask(scope, {
              task: "Implement the parser",
              role,
            });
            assert.isUndefined(task.workspaceNote);
            yield* tracker.stream(task.childThreadId).pipe(
              Stream.filter((snapshot) => snapshot?.phase === "done"),
              Stream.runHead,
            );
            assert.equal(harness.localStatus.mock.calls[0]?.[0]?.cwd, "/repo");
            const worktree = harness.createWorktree.mock.calls[0]![0];
            assert.equal(worktree.cwd, "/repo");
            assert.equal(worktree.refName, "main");
          }),
        rootParent,
      );
    },
  );

  it.effect("keeps a defaulted child in a detached checkout and says so", () => {
    const harness = makeHarness({
      providers: [codexProvider],
      localStatus: rootCheckoutStatus(null),
    });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const task = yield* service.delegateTask(scope, {
            task: "Implement the parser",
            role: "implementation",
          });
          assert.isString(task.workspaceNote);
          assert.isNull(task.worktreePath);
          assert.equal(harness.createWorktree.mock.calls.length, 0);
          const child = yield* threads.getThreadProjection(task.childThreadId);
          assert.equal(child.runs[0]?.status, "starting");
        }),
      rootParent,
    );
  });

  it.effect("rejects an explicit worktree from a detached checkout", () => {
    const harness = makeHarness({
      providers: [codexProvider],
      localStatus: rootCheckoutStatus(null),
    });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const error = yield* service
            .delegateTask(scope, { task: "Implement the parser", workspace: "worktree" })
            .pipe(Effect.flip);
          assert.equal(error.code, "invalid_request");
          assert.include(error.message, "detached HEAD");
        }),
      rootParent,
    );
  });

  it.effect("cuts the child from a branch switched to just before delegating", () => {
    const checkout = switchableCheckout("main");
    const harness = makeHarness({ providers: [codexProvider], ...checkout });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          yield* harness.localStatus({ cwd: "/repo" });
          checkout.switchTo("feature/switched");
          const task = yield* service.delegateTask(scope, {
            task: "Implement the parser",
            role: "implementation",
          });
          yield* tracker.stream(task.childThreadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
          assert.equal(harness.createWorktree.mock.calls[0]![0].refName, "feature/switched");
        }),
      rootParent,
    );
  });

  it.effect.each([{ role: "implementation" }, { workspace: "worktree" }] as const)(
    "keeps an accepted worktree child when a retry finds the checkout detached (%j)",
    (workspaceChoice) => {
      const checkout = switchableCheckout("main");
      const harness = makeHarness({ providers: [codexProvider], ...checkout });
      return withDelegatingParent(
        harness,
        (service) =>
          Effect.gen(function* () {
            const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
            const request = {
              task: "Implement the parser",
              ...workspaceChoice,
              clientRequestId: "detached-retry",
            };
            const task = yield* service.delegateTask(scope, request);
            yield* tracker.stream(task.childThreadId).pipe(
              Stream.filter((snapshot) => snapshot?.phase === "done"),
              Stream.runHead,
            );
            checkout.switchTo(null);
            const retried = yield* service.delegateTask(scope, request);
            assert.equal(retried.taskId, task.taskId);
            assert.isUndefined(retried.workspaceNote);
            assert.equal(retried.worktreePath, "/repo-worktrees/feature");
            assert.equal(harness.createWorktree.mock.calls.length, 1);
          }),
        rootParent,
      );
    },
  );
});
