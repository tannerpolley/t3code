import { PROJECT_ARTIFACT_METHODS } from "@t3tools/contracts";
import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { createOwnerDecisionAtoms } from "./ownerDecisions.ts";
import { createIssueEnvironmentAtoms } from "./issues.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("artifact mutations never reach transport without the destination grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.mount(sessions(other));
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        const calls: string[] = [];
        const add = createEnvironmentRpcCommand(runtime, {
          label: "test.artifacts.add",
          tag: PROJECT_ARTIFACT_METHODS.add,
          execute: () =>
            Effect.sync(() => {
              calls.push("add");
              return {
                id: "pin",
                path: "paper.qmd",
                resolvedPath: "/science/paper.qmd",
                name: "paper.qmd",
                label: null,
                section: "Documents",
                addedBy: "user" as const,
                available: true,
              };
            }),
        });
        const remove = createEnvironmentRpcCommand(runtime, {
          label: "test.artifacts.remove",
          tag: PROJECT_ARTIFACT_METHODS.remove,
          execute: () =>
            Effect.sync(() => {
              calls.push("remove");
            }),
        });
        const projectId = ProjectId.make("science");
        expect(
          (yield* Effect.promise(() =>
            add.run(registry, { environmentId: other, input: { projectId, path: "paper.qmd" } }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.promise(() =>
            remove.run(registry, { environmentId: other, input: { projectId, id: "pin" } }),
          ))._tag,
        ).toBe("Failure");
        expect(calls).toEqual([]);
        expect(
          (yield* Effect.promise(() =>
            add.run(registry, { environmentId: env, input: { projectId, path: "paper.qmd" } }),
          ))._tag,
        ).toBe("Success");
        expect(
          (yield* Effect.promise(() =>
            remove.run(registry, { environmentId: env, input: { projectId, id: "pin" } }),
          ))._tag,
        ).toBe("Success");
        expect(calls).toEqual(["add", "remove"]);
      }),
    ),
  );

  it.effect("sidebar writes check the destination grant before calling transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.mount(sessions(other));
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(
          sessions(other),
          AsyncResult.success({ ...grant(true), permissions: [AuthSettingsWriteScope] }),
        );
        let calls = 0;
        const command = createEnvironmentRpcCommand(runtime, {
          label: "test.sidebar",
          tag: WS_METHODS.sidebarLayoutUpdate,
          execute: () =>
            Effect.sync(() => {
              calls++;
              return {
                revision: 1,
                legacyImportedAt: null,
                legacyImportId: null,
                layout: {
                  sidebarProjectSections: [],
                  projectExpandedById: {},
                  projectOrder: [],
                  sidebarOtherProjectsExpanded: false,
                },
              };
            }),
        });
        const input = {
          revision: 0,
          operations: [{ type: "otherExpanded" as const, expanded: false }],
        };
        expect(
          (yield* Effect.promise(() => command.run(registry, { environmentId: env, input })))._tag,
        ).toBe("Failure");
        expect(calls).toBe(0);
        expect(
          (yield* Effect.promise(() => command.run(registry, { environmentId: other, input })))
            ._tag,
        ).toBe("Success");
        expect(calls).toBe(1);
      }),
    ),
  );

  it.effect(
    "guards shared sidebar settings and create-with-section against the destination grants",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.mount(sessions(other));
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          registry.set(
            sessions(other),
            AsyncResult.success({
              ...grant(true),
              permissions: [AuthOrchestrationOperateScope, AuthSettingsWriteScope],
            }),
          );
          const settings = createCommandPermissions(runtime, WS_METHODS.sidebarLayoutUpdate);
          const input = {
            revision: 0,
            operations: [{ type: "add", section: { id: "work", name: "Work" } }],
          };
          expect(registry.get(settings.permissionAtom(env, input))).toBe(false);
          expect(
            (yield* settings.authorize(registry, env, input).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthSettingsWriteScope);
          expect(registry.get(settings.permissionAtom(other, input))).toBe(true);
          yield* settings.authorize(registry, other, input);
          const create = createCommandPermissions(runtime, WS_METHODS.projectsCreateNew);
          const placed = { name: "New project", sectionId: "work", sidebarExpanded: true };
          expect(registry.get(create.permissionAtom(env, placed))).toBe(false);
          expect(registry.get(create.permissionAtom(other, placed))).toBe(true);
          yield* create.authorize(registry, other, placed);
          registry.set(sessions(other), AsyncResult.success(grant(true)));
          expect(
            (yield* settings.authorize(registry, other, input).pipe(Effect.flip))
              .requiredPermission,
          ).toBe(AuthSettingsWriteScope);
        }),
      ),
  );

  it.effect(
    "requires the destination operate grant for artifacts, issue recovery and inbox writes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          for (const method of [
            PROJECT_ARTIFACT_METHODS.add,
            PROJECT_ARTIFACT_METHODS.remove,
            PROJECT_ARTIFACT_METHODS.move,
            PROJECT_ARTIFACT_METHODS.renameSection,
            PROJECT_ARTIFACT_METHODS.reorderSections,
            WS_METHODS.issuesCloseOut,
            WS_METHODS.issuesCancelRequest,
            WS_METHODS.issuesRestoreRoot,
            WS_METHODS.issuesAssignOrchestrator,
            WS_METHODS.issuesInboxMarkRead,
            WS_METHODS.ownerDecisionsChoose,
            WS_METHODS.issuesSetWorkerLimit,
            WS_METHODS.issuesSetReadOnlyLimit,
            WS_METHODS.issuesQueue,
            WS_METHODS.issuesUnqueue,
          ]) {
            const recovery = createCommandPermissions(runtime, method);
            expect(registry.get(recovery.permissionAtom(env))).toBe(true);
            yield* recovery.authorize(registry, env);
            expect(registry.get(recovery.permissionAtom(other))).toBe(false);
            expect((yield* recovery.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
              "EnvironmentAuthorizationError",
            );
          }
        }),
      ),
  );

  it.effect("sends issue recovery commands only to an environment that grants them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.mount(sessions(other));
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        const calls: string[] = [];
        const session = {
          client: {
            [WS_METHODS.ownerDecisionsChoose]: () =>
              Effect.sync(() => calls.push(WS_METHODS.ownerDecisionsChoose)),
            [WS_METHODS.issuesCloseOut]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesCloseOut)),
            [WS_METHODS.issuesCancelRequest]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesCancelRequest)),
            [WS_METHODS.issuesQueue]: () => Effect.sync(() => calls.push(WS_METHODS.issuesQueue)),
            [WS_METHODS.issuesUnqueue]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesUnqueue)),
            [WS_METHODS.issuesSetWorkerLimit]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesSetWorkerLimit)),
            [WS_METHODS.issuesSetReadOnlyLimit]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesSetReadOnlyLimit)),
            [WS_METHODS.issuesAssignOrchestrator]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesAssignOrchestrator)),
            [WS_METHODS.issuesRestoreRoot]: () =>
              Effect.sync(() => calls.push(WS_METHODS.issuesRestoreRoot)),
          },
        } as unknown as RpcSession;
        const supervisor = {
          target: { environmentId: env, label: "target" },
          session: yield* SubscriptionRef.make(Option.some(session)),
        } as unknown as EnvironmentSupervisor["Service"];
        const issueRuntime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id: EnvironmentId, effect: Effect.Effect<unknown, never, never>) =>
              Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          } as unknown as EnvironmentRegistry["Service"]),
        );
        const issues = createIssueEnvironmentAtoms(issueRuntime, () => Atom.make(null));
        const decisions = createOwnerDecisionAtoms(issueRuntime);
        const scope = {
          host: "github.com",
          repository: "owner/repo",
          projectId: ProjectId.make("project"),
          reason: "recover",
          clientRequestId: CommandId.make("recovery"),
        };
        const cancel = {
          ...scope,
          expectedRootThreadId: ThreadId.make("root"),
          requestId: CommandId.make("request"),
        };
        const restore = {
          ...scope,
          repositoryId: "1",
          expectedRootThreadId: ThreadId.make("root"),
          expectedRevision: 2,
          targetThreadId: ThreadId.make("lead"),
        };
        const scopeWithTarget = { ...scope, targetThreadId: ThreadId.make("lead") };
        for (const environmentId of [other, env]) {
          const outcome = environmentId === env ? "Success" : "Failure";
          const chosen = yield* Effect.promise(() =>
            decisions.choose.run(registry, {
              environmentId,
              input: { id: "D1", optionId: "adopt" },
            }),
          );
          expect(chosen._tag).toBe(outcome);
          const closedOut = yield* Effect.promise(() =>
            issues.closeOut.run(registry, {
              environmentId,
              input: { ...scope, issueId: "issue", expectedRevision: 2 },
            }),
          );
          const cancelled = yield* Effect.promise(() =>
            issues.cancelRequest.run(registry, { environmentId, input: cancel }),
          );
          const restored = yield* Effect.promise(() =>
            issues.restoreRoot.run(registry, { environmentId, input: restore }),
          );
          const assigned = yield* Effect.promise(() =>
            issues.assignOrchestrator.run(registry, { environmentId, input: scopeWithTarget }),
          );
          const limited = yield* Effect.promise(() =>
            issues.setWorkerLimit.run(registry, {
              environmentId,
              input: { ...scope, workerLimit: 8, expectedRevision: 2 },
            }),
          );
          const readOnlyLimited = yield* Effect.promise(() =>
            issues.setReadOnlyLimit.run(registry, {
              environmentId,
              input: { ...scope, readOnlyLimit: 8, expectedRevision: 2 },
            }),
          );
          const queued = yield* Effect.promise(() =>
            issues.queueIssue.run(registry, { environmentId, input: { ...scope, number: 1 } }),
          );
          const unqueued = yield* Effect.promise(() =>
            issues.unqueueIssue.run(registry, { environmentId, input: { ...scope, number: 1 } }),
          );
          expect([
            closedOut._tag,
            cancelled._tag,
            restored._tag,
            assigned._tag,
            limited._tag,
            readOnlyLimited._tag,
            queued._tag,
            unqueued._tag,
          ]).toEqual([outcome, outcome, outcome, outcome, outcome, outcome, outcome, outcome]);
        }
        expect(calls).toEqual([
          WS_METHODS.ownerDecisionsChoose,
          WS_METHODS.issuesCloseOut,
          WS_METHODS.issuesCancelRequest,
          WS_METHODS.issuesRestoreRoot,
          WS_METHODS.issuesAssignOrchestrator,
          WS_METHODS.issuesSetWorkerLimit,
          WS_METHODS.issuesSetReadOnlyLimit,
          WS_METHODS.issuesQueue,
          WS_METHODS.issuesUnqueue,
        ]);
      }),
    ),
  );

  it.effect.each(["delete-branch", "remove-worktree"] as const)(
    "issue cleanup (%s) checks source-control permission at execution in the destination environment",
    (action) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.mount(sessions(other));
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              permissions: [AuthSourceControlWriteScope],
              scopes: [AuthSourceControlWriteScope],
            }),
          );
          registry.set(sessions(other), AsyncResult.success(grant(true)));
          let calls = 0;
          const session = {
            client: {
              [WS_METHODS.issuesCleanup]: () =>
                Effect.sync(() => {
                  calls++;
                }),
            },
          } as unknown as RpcSession;
          const supervisor = {
            target: { environmentId: env, label: "target" },
            session: yield* SubscriptionRef.make(Option.some(session)),
          } as unknown as EnvironmentSupervisor["Service"];
          const issues = createIssueEnvironmentAtoms(
            Atom.runtime(
              Layer.succeed(EnvironmentRegistry, {
                run: (_id: EnvironmentId, effect: Effect.Effect<unknown, never, never>) =>
                  Effect.provideService(effect, EnvironmentSupervisor, supervisor),
              } as unknown as EnvironmentRegistry["Service"]),
            ),
            () => Atom.make(null),
          );
          const input = {
            host: "github.com",
            repository: "owner/repo",
            number: 1,
            threadId: ThreadId.make("worker"),
            action,
            expectedBranch: "work",
            expectedWorktreePath: null,
            confirmed: true,
            confirmUnmerged: false,
          };
          expect(registry.get(issues.cleanup.permissionAtom(env))).toBe(true);
          expect(registry.get(issues.cleanup.permissionAtom(other))).toBe(false);
          expect(
            (yield* Effect.promise(() =>
              issues.cleanup.run(registry, { environmentId: other, input }),
            ))._tag,
          ).toBe("Failure");
          expect(calls).toBe(0);
          expect(
            (yield* Effect.promise(() =>
              issues.cleanup.run(registry, { environmentId: env, input }),
            ))._tag,
          ).toBe("Success");
          expect(calls).toBe(1);
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          expect(
            (yield* Effect.promise(() =>
              issues.cleanup.run(registry, { environmentId: env, input }),
            ))._tag,
          ).toBe("Failure");
          expect(calls).toBe(1);
        }),
      ),
  );

  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(close.permissionAtom(env))).toBe(false);
        expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthPreviewOperateScope],
            permissions: [AuthPreviewOperateScope],
          }),
        );
        expect(registry.get(close.permissionAtom(env))).toBe(true);
        yield* close.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(close.permissionAtom(other))).toBe(false);
        expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect(
  "requires thread operation permission in the destination environment to return to root",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, WS_METHODS.worktreeReturnToRoot);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(command.permissionAtom(env))).toBe(false);
        expect((yield* command.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationOperateScope,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(command.permissionAtom(env))).toBe(true);
        yield* command.authorize(registry, env);
        expect(registry.get(command.permissionAtom(other))).toBe(false);
      }),
    ),
);

it.effect.each(["commit", "push", "commit_push", "create_pr", "commit_push_pr"] as const)(
  "%s needs thread read permission only when generating a PR from a thread",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, WS_METHODS.gitRunStackedAction);
        const input = { actionId: "action", cwd: "/repo", action };
        const withThread = { ...input, threadId: ThreadId.make("thread") };
        const session = {
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(session));
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        const readsThread = action === "create_pr" || action === "commit_push_pr";
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(!readsThread);
        if (readsThread) {
          expect(
            yield* command.authorize(registry, env, withThread).pipe(Effect.flip),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
        } else {
          yield* command.authorize(registry, env, withThread);
        }
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...session,
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(true);
        yield* command.authorize(registry, env, withThread);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect("guards inline shell launch and input against the destination terminal grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthTerminalOperateScope],
          permissions: [AuthTerminalOperateScope],
        }),
      );
      registry.set(sessions(other), AsyncResult.success(grant(true)));
      for (const method of [WS_METHODS.terminalRunInline, WS_METHODS.terminalWrite]) {
        const permission = createCommandPermissions(runtime, method);
        expect(registry.get(permission.permissionAtom(env))).toBe(true);
        yield* permission.authorize(registry, env);
        expect(registry.get(permission.permissionAtom(other))).toBe(false);
        expect((yield* permission.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }
    }),
  ),
);

it.effect("issue state and unlink writes check the destination's exact grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const issues = createIssueEnvironmentAtoms(runtime, () => Atom.make(null));
      const statePermission = issues.setState.permissionAtom(env);
      const unlinkPermission = issues.unlink.permissionAtom(env);
      registry.set(
        sessions(env),
        AsyncResult.success({ ...grant(true), permissions: [AuthSourceControlWriteScope] }),
      );
      expect(registry.get(statePermission)).toBe(true);
      expect(registry.get(unlinkPermission)).toBe(false);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(statePermission)).toBe(false);
      expect(registry.get(unlinkPermission)).toBe(true);
      const failed = yield* Effect.promise(() =>
        issues.setState.run(registry, {
          environmentId: env,
          input: { host: "github.com", repository: "owner/repo", number: 44, state: "closed" },
        }),
      );
      expect(failed._tag).toBe("Failure");
    }),
  ),
);
