import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as IssueWorkStore from "./IssueWorkStore.ts";

const dependencies = Layer.mergeAll(IssueWorkStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
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
