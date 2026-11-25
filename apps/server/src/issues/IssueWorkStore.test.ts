import { assert, it } from "@effect/vitest";
import {
  repositoryPhase,
  repositoryAdmitsWork,
  ProviderInstanceId,
  CommandId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { repositoryPhaseSql, repositoryAdmissionSql } from "./RepositoryPhaseSql.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";

const dependencies = Layer.mergeAll(IssueWorkStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect.each([
  { name: "archived worker", archived: true, count: 0 },
  { name: "interrupted worker", run: "interrupted", count: 0 },
  { name: "worker on a merged branch", merged: true, count: 0 },
  { name: "closed issue", closed: true, count: 0 },
  { name: "idle worker on an open issue", count: 1 },
  { name: "archived worker with pending work", archived: true, run: "waiting", count: 1 },
  {
    name: "archived worker with an obsolete provider task",
    archived: true,
    roster: "old",
    count: 0,
  },
  {
    name: "archived worker with a current provider task",
    archived: true,
    roster: "current",
    count: 1,
  },
  { name: "worker waiting for a merged PR notification", merged: true, watch: true, count: 1 },
])("counts slots for $name", ({ archived, run, merged, closed, roster, watch, count }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = ThreadId.make("root");
    const issue = { host: "github.com", repositoryId: "repo", repository: "owner/repo", id: "1" };
    const rootPayload = JSON.stringify({
      repositoryOrchestration: { suspendedIssues: closed ? [{ id: "1", kind: "closed" }] : [] },
    });
    const workerPayload = JSON.stringify({
      linkedIssue: issue,
      branch: "feature",
      worktreePath: "/repo/.worktrees/slot-1",
      pullRequests: merged
        ? [
            {
              host: issue.host,
              repository: issue.repository,
              source: "agent",
              snapshot: { state: "merged", headBranch: "feature" },
              ...(watch ? { watch: { passed: true, checksPending: false } } : {}),
            },
          ]
        : [],
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, payload_json)
      VALUES ('root', 'project', 'Root', 'codex', 'full-access', 'default', '2026-11-24', '2026-11-24', NULL, ${rootPayload}),
        ('worker', 'project', 'Worker', 'codex', 'full-access', 'default', '2026-11-24', '2026-11-24', ${archived ? "2026-11-24" : null}, ${workerPayload})`;
    yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
      VALUES ('github.com', 'repo', 'owner/repo', 'root', 'project', 'project', 'start', 1, 0, 1, 1, 1, '2026-11-24', '2026-11-24')`;
    if (run !== undefined)
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run', 'worker', 1, 'codex', ${run}, '2026-11-24', '{}')`;
    if (roster !== undefined) {
      const pending = JSON.stringify({ pendingBackgroundTasks: [{ taskId: "command" }] });
      yield* sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'current'
        WHERE thread_id = 'worker'`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('current', 'worker', 'codex', 'idle', '2026-11-24', ${roster === "current" ? pending : "{}"}),
          ('old', 'worker', 'codex', 'idle', '2026-11-24', ${roster === "old" ? pending : "{}"})`;
    }
    assert.equal(yield* store.slotsInUse(root), count);
    if (watch) assert.isTrue(yield* store.workerRetainsSlot(ThreadId.make("worker"), true));
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "publishing reflects durable pending, failed, succeeded and cancelled outbox states",
  () =>
    Effect.gen(function* () {
      const store = yield* IssueWorkStore.IssueWorkStore;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("publishing-test");
      assert.equal(yield* store.publishing(threadId), "absent");
      yield* outbox.enqueue([
        {
          id: "publishing-test-effect",
          commandId: CommandId.make("publishing-test-command"),
          threadId,
          request: {
            type: "issue.github.comment",
            operation: "status_sync",
            issue: {
              host: "github.com",
              repository: "tannerpolley/t3code",
              repositoryId: "repo",
              id: "issue",
              nodeId: "node",
              number: 8,
              title: "Test",
              url: "https://github.com/tannerpolley/t3code/issues/8",
            },
            writeKey: "publishing-test-key",
            marker: "<!-- marker -->",
            body: "Working",
          },
        },
      ]);
      assert.equal(yield* store.publishing(threadId), "pending");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed', last_error = 'rate limited' WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "failed");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded', last_error = NULL WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "published");
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'cancelled' WHERE effect_id = 'publishing-test-effect'`;
      assert.equal(yield* store.publishing(threadId), "absent");
    }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "recovery inventory keeps only finished attempts with open PRs and omits their reports",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* IssueWorkStore.IssueWorkStore;
      const repository = { host: "github.com", repository: "owner/repo", repositoryId: "repo" };
      const report = "Historical worker report that must not enter the handoff.";
      const open = { source: "manual", snapshot: { state: "open" } };
      const scenarios = [
        { status: "completed", pullRequests: [open, open] },
        { status: "failed", pullRequests: [open] },
        { status: "cancelled", pullRequests: [open] },
        { status: "interrupted", pullRequests: [open] },
        { status: "completed", pullRequests: [] },
        { status: "completed", pullRequests: [{ ...open, snapshot: { state: "closed" } }] },
        { status: "completed", pullRequests: [{ ...open, snapshot: { state: "merged" } }] },
        { status: "completed", pullRequests: [{ ...open, snapshot: null }] },
        { status: "completed", pullRequests: [{ ...open, source: "stack-dismissed" }] },
        { status: "running", pullRequests: [open] },
        { status: "completed", pullRequests: [open], origin: "provider_native" },
        { status: "completed", pullRequests: [open], repositoryId: "other-repo" },
      ];
      for (const [index, scenario] of scenarios.entries()) {
        const threadId = `worker-${index}`;
        const payload = JSON.stringify({
          linkedIssue: {
            ...repository,
            number: index + 1,
            repositoryId: scenario.repositoryId ?? "repo",
          },
          pullRequests: scenario.pullRequests,
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_threads(
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (${threadId}, 'project', 'Worker', 'codex', 'full-access', 'default',
          '2026-10-24', '2026-10-24', ${payload})
      `;
        yield* sql`
        INSERT INTO orchestration_v2_projection_subagents(
          subagent_id, thread_id, child_thread_id, parent_node_id, provider, origin,
          status, updated_at, payload_json
        ) VALUES (${threadId}, 'root', ${threadId}, 'node', 'codex',
          ${scenario.origin ?? "app_owned"}, ${scenario.status}, '2026-10-24',
          ${JSON.stringify({ result: report })})
      `;
      }

      const inventory = yield* store.recoveryInventory(repository);
      assert.notInclude(JSON.stringify(inventory), report);
      assert.deepEqual(inventory, [
        { section: "Completed attempts", detail: "#1. completed. thread worker-0" },
        { section: "Completed attempts", detail: "#2. failed. thread worker-1" },
        { section: "Completed attempts", detail: "#3. cancelled. thread worker-2" },
        { section: "Completed attempts", detail: "#4. interrupted. thread worker-3" },
      ]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("reads the latest handed-back result once per direct child", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const report = "Open the PR. ".repeat(40).trim();
    for (const [id, archivedAt, deletedAt] of [
      ["child", null, null],
      ["archived", "2026-11-18", null],
      ["deleted", null, "2026-11-18"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads(
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (${id}, 'project', 'Child', 'codex', 'full-access', 'default',
        '2026-11-16', '2026-11-18', ${archivedAt}, ${deletedAt}, '{}')`;
    }
    for (const [id, parent, child, origin, completedAt, result] of [
      ["older", "root", "child", "app_owned", "2026-11-16", "First report"],
      ["latest", "root", "child", "app_owned", "2026-11-17", report],
      ["resumed", "root", "child", "app_owned", null, null],
      ["grandchild", "child", "grandchild", "app_owned", "2026-11-18", "Nested report"],
      ["archived", "root", "archived", "app_owned", "2026-11-18", "Archived report"],
      ["deleted", "root", "deleted", "app_owned", "2026-11-18", "Deleted report"],
      ["native", "root", "child", "provider_native", "2026-11-18", "Native report"],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents(
          subagent_id, thread_id, child_thread_id, parent_node_id, provider, origin,
          status, completed_at, updated_at, payload_json
        ) VALUES (${id}, ${parent}, ${child}, 'node', 'codex', ${origin},
          ${completedAt === null ? "running" : "completed"}, ${completedAt}, '2026-11-18',
          ${JSON.stringify({ result })})
      `;
    }
    assert.deepEqual(yield* store.childTaskSummaries(ThreadId.make("root")), [
      { threadId: ThreadId.make("child"), lastSummary: report.slice(0, 320).trim() },
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("keeps roots with persisted blocker suspensions eligible for automatic recovery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('root', 'project', 'Root', 'codex', 'full-access', 'default', '2026-10-28', '2026-10-28', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
      VALUES ('github.com', 'repo', 'owner/repo', 'root', 'project', 'project', 'start', 1, 0, 4, 1, 1, '2026-10-28', '2026-10-28')`;
    for (const reason of [
      "A GitHub blocker is open. Resolve it before resuming.",
      "An issue host blocker is open. Resolve it before resuming.",
      "Paused by owner",
      "Reworded blocker",
    ]) {
      const payload = JSON.stringify({
        repositoryOrchestration: {
          suspendedIssues: [
            { id: "issue", reason, ...(reason === "Reworded blocker" ? { kind: "blocked" } : {}) },
          ],
        },
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload} WHERE thread_id = 'root'`;
      assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
    }
  }).pipe(Effect.provide(dependencies)),
);

it.effect("keeps roots with an unheld queued reader active for the admission sweep", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('root', 'project', 'Root', 'codex', 'full-access', 'default', '2026-11-23', '2026-11-23', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository, root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit, publish_status_comments, publish_closeout_comments, created_at, updated_at)
      VALUES ('github.com', 'repo', 'owner/repo', 'root', 'project', 'project', 'start', 1, 0, 4, 1, 1, '2026-11-23', '2026-11-23')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('reader', 'project', 'Reader', 'codex', 'full-access', 'default', '2026-11-23', '2026-11-23',
        '{"role":"reviewer","lineage":{"rootThreadId":"root","relationshipToParent":"subagent"}}')`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
    yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run', 'reader', 1, 'codex', 'queued', '2026-11-23', '{"queueHeld":true}')`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"admissionWait":"read_only_limit"}'`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rechecks a paused repository for closure after a managed result was observed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider,
      runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('root', 'project', 'Root', 'codex', 'full-access', 'default', '2026-11-23', '2026-11-23', '{}'),
        ('worker', 'project', 'Worker', 'codex', 'full-access', 'default', '2026-11-23', '2026-11-23',
          '{"lineage":{"rootThreadId":"root","parentThreadId":"root","relationshipToParent":"subagent"}}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_repository_orchestration(host, repository_id, repository,
      root_thread_id, project_id, workspace, launch_command_id, revision, paused, worker_limit,
      publish_status_comments, publish_closeout_comments, created_at, updated_at)
      VALUES ('github.com', 'repo', 'owner/repo', 'root', 'project', 'project', 'start', 1, 1, 4, 1, 1, '2026-11-23', '2026-11-23')`;
    yield* sql`INSERT INTO orchestration_v2_projection_issue_work(host, repository_id, issue_id,
      issue_number, repository, node_id, issue_url, issue_title, owner_thread_id, status_marker, updated_at)
      VALUES ('github.com', 'repo', 'issue', 1, 'owner/repo', 'issue-node',
        'https://github.com/owner/repo/issues/1', 'Issue', 'worker', 'marker', '2026-11-23')`;
    yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id, thread_id, child_thread_id,
      parent_node_id, provider, origin, status, completed_at, completion_delivery_state, updated_at, payload_json)
      VALUES ('task', 'root', 'worker', 'node', 'codex', 'app_owned', 'completed', '2026-11-23',
        'delivered', '2026-11-23', '{}')`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
    yield* sql`UPDATE orchestration_v2_projection_subagents
      SET payload_json = '{"completionDelivery":{"state":"delivered","observedByRunId":"wake"}}'`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-24'
      WHERE thread_id = 'worker'`;
    assert.deepEqual(yield* store.activeRoots(), [ThreadId.make("root")]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("drains past an item left open by an ended run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    const root = ThreadId.make("root");
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('worker', 'project', 'Worker', 'codex', 'full-access', 'default', '2026-11-23', '2026-11-23',
        '{"lineage":{"rootThreadId":"root","relationshipToParent":"subagent"}}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run', 'worker', 1, 'codex', 'running', '2026-11-23', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('message', 'worker', 'run', 1, 'user_message', 'pending', '2026-11-23', '{}')`;
    assert.isFalse(yield* store.subtreeDrained(root));
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'`;
    assert.isTrue(yield* store.subtreeDrained(root));
  }).pipe(Effect.provide(dependencies)),
);

it.effect("admission visits only read-only threads with queued or preparing work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssueWorkStore.IssueWorkStore;
    for (const status of ["completed", "running", "waiting", "queued", "preparing", "idle"]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${status}, 'project', 'Child', 'codex', 'full-access', 'default', '2026-11-09', '2026-11-09',
          '{"role":"checker","lineage":{"rootThreadId":"root","relationshipToParent":"subagent"}}')`;
      if (status !== "idle")
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${status}, ${status}, 1, 'codex', ${status}, '2026-11-09', '{}')`;
    }
    assert.deepEqual(yield* store.admissionThreads(ThreadId.make("root")), [
      ThreadId.make("preparing"),
      ThreadId.make("queued"),
    ]);
    assert.equal(yield* store.readOnlySlotsInUse(ThreadId.make("root")), 3);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("SQL phase and admission agree with contracts for every stored field combination", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const status of ["verifying", "failed"] as const) {
      const config = { paused: false, automaticHandoff: { status } };
      const payload = JSON.stringify({ repositoryOrchestration: config });
      const [row] = yield* sql<{ phase: string; allowed: number }>`SELECT
        ${sql.unsafe(repositoryPhaseSql("payload"))} AS phase,
        ${sql.unsafe(repositoryAdmissionSql("payload"))} AS allowed
        FROM (SELECT ${payload} AS payload)`;
      assert.equal(row?.phase, status === "verifying" ? "handoff_verifying" : "active");
      assert.equal(row?.phase, repositoryPhase(config));
      assert.equal(row?.allowed === 1, status === "failed");
      assert.equal(row?.allowed === 1, repositoryAdmitsWork(config));
    }
    for (const paused of [false, true]) {
      for (const status of [undefined, "awaiting_approval", "draining"] as const) {
        for (const retired of [undefined, null, ThreadId.make("next")]) {
          const config = {
            paused,
            ...(status
              ? {
                  handoff: {
                    status,
                    requestId: CommandId.make("request"),
                    nextThreadId: ThreadId.make("next"),
                    summary: "Continue",
                    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                    wasPaused: paused,
                  },
                }
              : {}),
            ...(retired !== undefined ? { retiredToThreadId: retired } : {}),
          };
          const payload = JSON.stringify({ repositoryOrchestration: config });
          const rows = yield* sql<{ phase: string; allowed: number }>`SELECT
            ${sql.unsafe(repositoryPhaseSql("payload"))} AS phase,
            ${sql.unsafe(repositoryAdmissionSql("payload"))} AS allowed
            FROM (SELECT ${payload} AS payload)`;
          assert.equal(rows[0]!.phase, repositoryPhase(config));
          assert.equal(rows[0]!.allowed === 1, repositoryAdmitsWork(config));
        }
      }
    }
  }).pipe(Effect.provide(dependencies)),
);
