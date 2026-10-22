import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_LOCAL_WORKTREES,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalSummary,
} from "@t3tools/contracts";

import * as ServerConfig from "./config.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const makeCleanupFixture = (
  location?: "custom" | "project-local",
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" });
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const directory =
      location === "custom"
        ? yield* fs.makeTempDirectoryScoped({ prefix: "old-custom-worktrees-" })
        : location === "project-local"
          ? `${repo}/.worktrees`
          : config.worktreesDir;
    const worktree = `${directory}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    let settings: import("@t3tools/contracts").ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreesDirectory:
        location === "custom"
          ? directory
          : location === "project-local"
            ? PROJECT_LOCAL_WORKTREES
            : "",
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let fullStatusCalls = 0;
    let snapshotReads = 0;
    let publishTerminal: Parameters<
      TerminalManager.TerminalManager["Service"]["subscribeMetadata"]
    >[0];
    const snapshotRead = yield* Deferred.make<void>();
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            if (editBeforeRemoval && input.args.includes("remove"))
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            return yield* git.execute(input);
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.gen(function* () {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            const snapshot = {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
            yield* Deferred.succeed(snapshotRead, undefined);
            return snapshot;
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.sync(() => sessionLive),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(SqlClient.SqlClient, ((strings: TemplateStringsArray) =>
        Effect.sync(() =>
          openSessionCwd !== null && strings.join("").includes("projection_provider_sessions")
            ? [
                {
                  payload_json: JSON.stringify({
                    id: "session-1",
                    driver: "codex",
                    providerInstanceId: "codex",
                    status: "ready",
                    cwd: openSessionCwd,
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: "2026-06-01T12:00:00.000Z",
                    updatedAt: "2026-06-01T12:00:00.000Z",
                    lastError: null,
                  }),
                },
              ]
            : strings.join("").includes('AS "worktreePath"')
              ? [
                  ...threads.flatMap((thread) => thread.worktreePath ?? []),
                  ...storedWorktreePaths,
                ].map((worktreePath) => ({ worktreePath }))
              : [],
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribeMetadata"]>[0],
        ) =>
          Effect.sync(() => {
            publishTerminal = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setLocation: (directory: string) => {
        settings = applyServerSettingsPatch(settings, { worktreesDirectory: directory });
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      setTerminals: (terminals: TerminalSummary[]) =>
        publishTerminal({ type: "snapshot", terminals }),
      fullStatusCalls: () => fullStatusCalls,
      snapshotReads: () => snapshotReads,
      snapshotRead,
      currentThreads: () => threads,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe("storage cleanup reports and local file policies", () => {
  it.live("cleans old custom worktrees after switching to project-local mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const harness = yield* makeCleanupFixture("custom");
        harness.setLocation(PROJECT_LOCAL_WORKTREES);
        const report = yield* harness.service.runNow;
        expect(report.entries.find((entry) => entry.path === harness.worktree)?.outcome).toBe(
          "removed",
        );
        expect(yield* harness.fs.exists(harness.worktree)).toBe(false);
      }),
    ),
  );

  it.live("cleans project-local worktrees after switching back to T3 home", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const harness = yield* makeCleanupFixture("project-local");
        harness.setLocation("");
        const report = yield* harness.service.runNow;
        expect(report.entries.find((entry) => entry.path === harness.worktree)?.outcome).toBe(
          "removed",
        );
        expect(yield* harness.fs.exists(harness.worktree)).toBe(false);
      }),
    ),
  );
});

describe("explicit worktree removal", () => {
  const request = (worktreePath: string) => ({
    projectId: ProjectId.make("project-1"),
    worktreePath,
  });

  it.effect(
    "removes a clean recent checkout with cleanup disabled and preserves its branch and thread path",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const f = yield* makeCleanupFixture("project-local");
          f.disable();
          f.setThreads([
            shell({
              branch: "feature",
              worktreePath: f.worktree,
              createdAt: at(0),
              latestUserMessageAt: at(0),
              latestRunCompletedAt: at(0),
              latestRunId: RunId.make("run-1"),
              updatedAt: at(0),
            }),
          ]);
          expect((yield* f.service.runNow).entries).toEqual([]);
          const result = yield* f.service.removeWorktreeNow(request(f.worktree));
          expect(result).toEqual({ outcome: "removed", reason: "Requested by owner" });
          expect(yield* f.fs.exists(f.worktree)).toBe(false);
          expect(
            (yield* f.command(f.repo, ["show-ref", "--verify", "refs/heads/feature"])).exitCode,
          ).toBe(0);
          expect(f.snapshotReads()).toBe(1);
          expect(f.currentThreads()[0]).toMatchObject({
            branch: "feature",
            worktreePath: f.worktree,
          });
        }),
      ),
  );

  it.effect("removes a checkout stored through a symlink and `..`, resolving it physically", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const f = yield* makeCleanupFixture("project-local");
        f.disable();
        const sibling = `${f.worktree.slice(0, f.worktree.lastIndexOf("/"))}/sibling`;
        yield* f.fs.makeDirectory(sibling);
        yield* f.fs.symlink(sibling, `${f.repo}/sibling-link`);
        // Physically the checkout; lexically `${f.repo}/<name>`, which doesn't exist.
        const alias = `${f.repo}/sibling-link/../${f.worktree.slice(f.worktree.lastIndexOf("/") + 1)}`;
        f.setThreads([
          shell({
            branch: "feature",
            worktreePath: alias,
            createdAt: at(0),
            latestUserMessageAt: at(0),
            latestRunCompletedAt: at(0),
            latestRunId: RunId.make("run-1"),
            updatedAt: at(0),
          }),
        ]);
        expect(yield* f.service.removeWorktreeNow(request(alias))).toEqual({
          outcome: "removed",
          reason: "Requested by owner",
        });
        expect(yield* f.fs.exists(f.worktree)).toBe(false);
      }),
    ),
  );

  it.effect("keeps the settle-script grace period even when cleanup is explicitly requested", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const f = yield* makeCleanupFixture("project-local");
        f.disable();
        f.setThreads([
          shell({
            branch: "feature",
            worktreePath: f.worktree,
            settledAt: at(0),
            updatedAt: at(0),
          }),
        ]);
        expect(yield* f.service.removeWorktreeNow(request(f.worktree))).toEqual({
          outcome: "kept",
          reason: "Settled moments ago",
        });
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }),
    ),
  );

  it.live(
    "refuses a thread that starts after the snapshot while waiting for the workspace lease",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootsChecked = yield* Deferred.make<void>();
          let managedRoot: string | undefined;
          let checkout: string | undefined;
          let checkoutChecked = false;
          const f = yield* makeCleanupFixture("project-local").pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: (target) => {
                if (target === checkout) checkoutChecked = true;
                return fs
                  .exists(target)
                  .pipe(
                    Effect.tap(() =>
                      target === managedRoot
                        ? Deferred.succeed(rootsChecked, undefined)
                        : Effect.void,
                    ),
                  );
              },
            }),
          );
          managedRoot = `${f.repo}/.worktrees`;
          checkout = f.worktree;
          f.disable();
          const aliasRoot = yield* f.fs.makeTempDirectoryScoped({ prefix: "cleanup-alias-" });
          yield* f.fs.symlink(f.repo, `${aliasRoot}/repo`);
          const alias = `${aliasRoot}/repo/.worktrees/feature`;
          const leased = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const start = yield* withWorkspaceLease(
            alias,
            Effect.gen(function* () {
              yield* Deferred.succeed(leased, undefined);
              yield* Deferred.await(resume);
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(leased);
          const removal = yield* f.service
            .removeWorktreeNow(request(f.worktree))
            .pipe(Effect.forkChild);
          yield* Deferred.await(rootsChecked);
          expect(checkoutChecked).toBe(false);
          expect(yield* fs.exists(f.worktree)).toBe(true);
          f.setThreads([shell({ branch: "feature", worktreePath: alias, status: "running" })]);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(start);
          expect(yield* Fiber.join(removal)).toEqual({
            outcome: "kept",
            reason: "Thread activity or shared worktree changed since check",
          });
          expect(yield* f.fs.exists(f.worktree)).toBe(true);
        }),
      ),
  );

  it.live.each([false, true])(
    "refuses removal through either alias of a shared active checkout (subagent: %s)",
    (subagent) =>
      runCleanupTest(
        Effect.gen(function* () {
          const f = yield* makeCleanupFixture("project-local");
          f.disable();
          const aliasRoot = yield* f.fs.makeTempDirectoryScoped({ prefix: "cleanup-alias-" });
          yield* f.fs.symlink(f.repo, `${aliasRoot}/repo`);
          const alias = `${aliasRoot}/repo/.worktrees/feature`;
          f.setThreads([
            shell({ branch: "feature", worktreePath: f.worktree }),
            shell({
              id: ThreadId.make("thread-2"),
              branch: "feature",
              worktreePath: alias,
              status: "running",
              ...(subagent
                ? {
                    lineage: {
                      rootThreadId: ThreadId.make("thread-1"),
                      parentThreadId: ThreadId.make("thread-1"),
                      relationshipToParent: "subagent" as const,
                    },
                  }
                : {}),
            }),
          ]);
          for (const target of [f.worktree, alias]) {
            expect(yield* f.service.removeWorktreeNow(request(target))).toEqual({
              outcome: "kept",
              reason: subagent ? "Thread is running or has pending work" : "Shared by 2 threads",
            });
          }
          f.setSettings({
            storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 0 },
          });
          expect((yield* f.service.runNow).entries).toEqual([
            expect.objectContaining({
              outcome: "kept",
              reason: subagent ? "Thread is running or has pending work" : "Shared by 2 threads",
            }),
          ]);
          expect(yield* f.fs.exists(f.worktree)).toBe(true);
        }),
      ),
  );

  it.live.each(["outside", "main"] as const)("refuses the %s checkout", (location) =>
    runCleanupTest(
      Effect.gen(function* () {
        const f = yield* makeCleanupFixture("project-local");
        const target = location === "main" ? f.repo : `${f.repo}/outside`;
        if (location === "outside")
          yield* f.command(f.repo, ["worktree", "add", "-b", "outside", target]);
        f.setThreads([
          shell({ branch: location === "main" ? "main" : "outside", worktreePath: target }),
        ]);
        expect(yield* f.service.removeWorktreeNow(request(target))).toEqual({
          outcome: "kept",
          reason: "Outside the managed worktree folder",
        });
        expect(yield* f.fs.exists(target)).toBe(true);
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
      }),
    ),
  );

  it.live.each(["idle", "project-checkout", "missing-project-checkout"] as const)(
    "checks an aliased checkout against canonical project roots (%s)",
    (state) =>
      runCleanupTest(
        Effect.gen(function* () {
          const f = yield* makeCleanupFixture("project-local");
          f.disable();
          const aliasRoot = yield* f.fs.makeTempDirectoryScoped({ prefix: "cleanup-alias-" });
          yield* f.fs.symlink(f.repo, `${aliasRoot}/repo`);
          const alias = `${aliasRoot}/repo/.worktrees/feature`;
          f.setThreads([shell({ branch: "feature", worktreePath: alias })]);
          if (state !== "idle")
            f.setProjectRoots([
              f.repo,
              state === "project-checkout" ? f.worktree : `${f.worktree}/missing/checkout`,
            ]);
          expect(yield* f.service.removeWorktreeNow(request(f.worktree))).toEqual(
            state === "idle"
              ? { outcome: "removed", reason: "Requested by owner" }
              : { outcome: "kept", reason: "Contains a project checkout" },
          );
          expect(yield* f.fs.exists(f.worktree)).toBe(state !== "idle");
        }),
      ),
  );

  it.live.each(["worktreePath", "cwd", "nested-cwd"] as const)(
    "keeps a checkout with an aliased terminal %s",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const f = yield* makeCleanupFixture("project-local");
          f.disable();
          const aliasRoot = yield* f.fs.makeTempDirectoryScoped({ prefix: "cleanup-alias-" });
          yield* f.fs.symlink(f.repo, `${aliasRoot}/repo`);
          const alias = `${aliasRoot}/repo/.worktrees/feature`;
          yield* f.fs.makeDirectory(`${f.worktree}/dist`);
          yield* f.setTerminals([
            {
              threadId: "other-thread",
              terminalId: "default",
              status: "running",
              cwd:
                location === "worktreePath" ? f.repo : location === "cwd" ? alias : `${alias}/dist`,
              worktreePath: location === "worktreePath" ? alias : null,
              pid: 1,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: false,
              label: "Shell",
              updatedAt: DateTime.formatIso(at(0)),
            },
          ]);
          expect(yield* f.service.removeWorktreeNow(request(f.worktree))).toEqual({
            outcome: "kept",
            reason: "Open terminal",
          });
          expect(yield* f.fs.exists(f.worktree)).toBe(true);
        }),
      ),
  );

  it.live.each(["tracked.txt", "notes.txt", ".env"])(
    "keeps local changes in %s even if automatic cleanup discards untracked files",
    (name) =>
      runCleanupTest(
        Effect.gen(function* () {
          const f = yield* makeCleanupFixture("project-local");
          f.setPolicy("tracked-changes");
          yield* f.fs.writeFileString(`${f.worktree}/${name}`, "keep me");
          expect(yield* f.service.removeWorktreeNow(request(f.worktree))).toMatchObject({
            outcome: "kept",
            reason: expect.stringMatching(/changes|ignored files/),
          });
          expect(yield* f.fs.readFileString(`${f.worktree}/${name}`)).toBe("keep me");
        }),
      ),
  );

  it.live.each(["physical", "alias", "nested-alias"] as const)(
    "keeps an idle checkout with a live provider session (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const f = yield* makeCleanupFixture("project-local");
          f.disable();
          const aliasRoot = yield* f.fs.makeTempDirectoryScoped({ prefix: "cleanup-alias-" });
          yield* f.fs.symlink(f.repo, `${aliasRoot}/repo`);
          const alias = `${aliasRoot}/repo/.worktrees/feature`;
          yield* f.fs.makeDirectory(`${f.worktree}/nested`);
          f.setOpenSessionCwd(
            location === "physical" ? f.worktree : location === "alias" ? alias : `${alias}/nested`,
          );
          expect(yield* f.service.removeWorktreeNow(request(f.worktree))).toEqual({
            outcome: "kept",
            reason: "Provider session is still open",
          });
          expect(yield* f.fs.exists(f.worktree)).toBe(true);
        }),
      ),
  );
});
