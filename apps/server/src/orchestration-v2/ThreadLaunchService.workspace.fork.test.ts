import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  adapter,
  makeHarness,
  modelSelection,
  projectId,
} from "./ThreadLaunchService.testHarness.ts";

describe("delegate_task isolation", () => {
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

  // The commit the parent's checkout is on; null means it has none (outside git).
  const checkoutHead = (initial: string | null = "parent-local-commit") => {
    let head = initial;
    const resolveCommit = vi.fn((_input: { readonly cwd: string; readonly revision: string }) =>
      head === null
        ? Effect.fail(
            new GitCommandError({
              operation: "resolveCommit",
              command: "git",
              cwd: _input.cwd,
              detail: "not a git repository",
            }),
          )
        : Effect.succeed({ commitSha: head }),
    );
    return {
      resolveCommit,
      moveTo: (commit: string | null) => {
        head = commit;
      },
    };
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
    head: ReturnType<typeof checkoutHead> = checkoutHead(),
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
              Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveCommit: head.resolveCommit }),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
        ),
      ),
    );

  it.effect.each([
    { isolation: "worktree" },
    { role: "implementation" },
    { role: "implementor" },
    { role: "checker", isolation: "worktree" },
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
          assert.equal(worktree.refName, "parent-local-commit");
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
    { role: "implementation", isolation: "shared" },
    { role: "test", isolation: "shared" },
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

  // A thread started in the project root records no worktree; the project root is its checkout.
  const rootParent = { branch: null, worktreePath: null };

  it.effect.each(["implementation", "implementor"] as const)(
    "cuts a root thread's %s child from the commit the project root is on",
    (role) => {
      const harness = makeHarness({ providers: [codexProvider] });
      const head = checkoutHead();
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
            assert.deepEqual(head.resolveCommit.mock.calls, [[{ cwd: "/repo", revision: "HEAD" }]]);
            const worktree = harness.createWorktree.mock.calls[0]![0];
            assert.equal(worktree.cwd, "/repo");
            assert.equal(worktree.refName, "parent-local-commit");
          }),
        rootParent,
        head,
      );
    },
  );

  it.effect("keeps a defaulted child in a checkout without a commit and says so", () => {
    const harness = makeHarness({ providers: [codexProvider] });
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
      checkoutHead(null),
    );
  });

  it.effect("rejects an explicit worktree from a checkout without a commit", () => {
    const harness = makeHarness({ providers: [codexProvider] });
    return withDelegatingParent(
      harness,
      (service) =>
        Effect.gen(function* () {
          const error = yield* service
            .delegateTask(scope, { task: "Implement the parser", isolation: "worktree" })
            .pipe(Effect.flip);
          assert.equal(error.code, "invalid_request");
          assert.equal(error.message, "Unable to resolve the parent checkout commit.");
        }),
      rootParent,
      checkoutHead(null),
    );
  });

  it.effect.each([{ role: "implementation" }, { isolation: "worktree" }] as const)(
    "keeps an accepted worktree child when a retry finds no commit (%j)",
    (workspaceChoice) => {
      const harness = makeHarness({ providers: [codexProvider] });
      const head = checkoutHead();
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
            head.moveTo(null);
            const retried = yield* service.delegateTask(scope, request);
            assert.equal(retried.taskId, task.taskId);
            assert.isUndefined(retried.workspaceNote);
            assert.equal(retried.worktreePath, "/repo-worktrees/feature");
            assert.equal(harness.createWorktree.mock.calls.length, 1);
          }),
        rootParent,
        head,
      );
    },
  );
});
