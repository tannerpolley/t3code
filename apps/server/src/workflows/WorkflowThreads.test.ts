// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture runs Git in a temporary repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkflowThreads from "./WorkflowThreads.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => exec("git", args, { cwd, encoding: "utf8" }));

const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "user.name=Fixture",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

it.live.each(["running", "dirty", "advanced"] as const)(
  "archives only the creator with a %s checkout and preserves the local ref",
  (status) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-cleanup-" });
      const worktreePath = path.join(workspaceRoot, "child");
      const child = ThreadId.make("child");
      const reviewer = ThreadId.make("reviewer");
      const projectId = ProjectId.make("project");
      const branch = "fixture-branch";
      const ref = `refs/heads/${branch}`;
      yield* git(workspaceRoot, "init", "-b", "main");
      yield* commit(workspaceRoot, "initial");
      yield* git(workspaceRoot, "worktree", "add", "-b", branch, worktreePath);
      const headSha = (yield* git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
      if (status === "advanced") yield* commit(worktreePath, "post-merge change");
      if (status === "dirty")
        yield* fs.writeFileString(path.join(worktreePath, "keep.txt"), "uncommitted");
      const tip = (yield* git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
      const head = {
        projectId,
        host: "github.com",
        repository: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        workspaceRoot,
        headSha,
        headBranch: branch,
        baseBranch: "main",
      };
      const waiting = yield* Deferred.make<void>();
      const finishTurn = yield* Deferred.make<void>();
      const runId = RunId.make("final-turn");
      let activeRunId = status === "running" ? runId : null;
      let archivedAt: DateTime.Utc | null = null;
      const archived: ThreadId[] = [];
      const parent = ThreadId.make("parent");
      const createdAt = "2026-11-01T00:00:00.000Z";
      const link = (id: ThreadId) =>
        ({
          host: head.host,
          repository: head.repository,
          number: head.number,
          url: head.url,
          source: id === child ? "created" : "agent",
          linkedAt: createdAt,
          snapshot: null,
          stack: null,
        }) satisfies ThreadPullRequestLink;
      const dependencies = Layer.mergeAll(
        Sqlite.layerMemory,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.sync(() => ({
              ...v2PullRequestThread({
                id,
                projectId,
                title: id,
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch,
                worktreePath,
                lineage: {
                  rootThreadId: parent,
                  parentThreadId: parent,
                  relationshipToParent: "subagent",
                },
                pullRequests: [link(id)],
                latestUserMessageAt: null,
                createdAt,
                updatedAt: createdAt,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
              }),
              archivedAt: id === child ? archivedAt : null,
              activeRunId: id === child ? activeRunId : null,
            })),
          waitForThread: (input) =>
            Effect.gen(function* () {
              assert.equal(input.runId, runId);
              assert.equal(input.threadId, child);
              yield* Deferred.succeed(waiting, undefined);
              yield* Deferred.await(finishTurn);
              return { threadId: child, run: null, timedOut: false };
            }),
          dispatch: (command) =>
            Effect.gen(function* () {
              assert(command.type === "thread.archive");
              archived.push(command.threadId);
              archivedAt = yield* DateTime.now;
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () => Effect.succeed([]),
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: ({ cwd, args }) =>
            git(cwd, ...args).pipe(
              Effect.map((output) => ({
                ...output,
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              })),
            ),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          removeWorktree: ({ cwd, path, force }) =>
            git(cwd, "worktree", "remove", ...(force ? ["--force"] : []), path).pipe(Effect.asVoid),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* WorkflowThreads.WorkflowThreads;
        const sql = yield* SqlClient.SqlClient;
        for (const id of [child, reviewer]) {
          const payload = yield* encodePayload({
            pullRequests: [link(id)],
          });
          yield* sql`
            INSERT INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              created_at, updated_at, payload_json
            ) VALUES (${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default',
              ${createdAt}, ${createdAt}, ${payload})
          `;
        }
        const cleanup = yield* service.cleanUpCreator(head).pipe(Effect.forkChild);
        if (status === "running") {
          yield* Deferred.await(waiting);
          assert.deepEqual(archived, []);
          activeRunId = null;
          yield* Deferred.succeed(finishTurn, undefined);
        }
        const result = yield* Fiber.join(cleanup);
        assert.deepEqual(archived, [child]);
        assert.equal((yield* git(workspaceRoot, "rev-parse", ref)).stdout.trim(), tip);
        assert.equal(yield* fs.exists(worktreePath), status !== "running");
        if (status === "dirty") assert.include(result, "local files or changes");
        if (status === "advanced") assert.include(result, "branch or commit changed");
      }).pipe(Effect.provide(WorkflowThreads.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.provide(NodeServices.layer)),
);
