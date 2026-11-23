import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageBudget from "./UsageBudget.ts";

it.effect(
  "ranks each settled turn once and keeps retries, native children and ledger residual distinct",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const budget = yield* UsageBudget.UsageBudget;
      const asOf = "2026-11-23T18:00:00.000Z";
      const since = "2026-11-16T18:00:00.000Z";
      const managedIssue = {
        host: "github.com",
        repositoryId: "repo",
        repository: "owner/repo",
        id: "issue",
        number: 508,
        title: "Usage",
        url: "https://github.com/owner/repo/issues/508",
      };
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread', 'project', 'Thread', 'claudeAgent', 'full-access', 'default', ${since}, ${since},
        ${JSON.stringify({ role: "designer", linkedIssue: { ...managedIssue, id: "moved", number: 9 } })})
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
      VALUES ('root', 'thread', NULL, 'claudeAgent', 'claudeAgent', 'claudeAgent', 'ready', ${since}, '{}'),
        ('child', 'thread', 'node', 'claudeAgent', 'claudeAgent', 'claudeAgent', 'ready', ${since}, '{}'),
        ('codex', 'thread', NULL, 'codex', 'codex', 'codex', 'ready', ${since}, '{}')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run', 'thread', 1, 'claudeAgent', 'completed', ${since}, ${JSON.stringify({
        userMessageId: "message",
        usageAttribution: {
          linkedIssue: managedIssue,
          role: "implementor",
          stage: "Plan execution",
        },
      })})
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('linked-run', 'thread', 2, 'claudeAgent', 'completed', ${since}, ${JSON.stringify({
        usageAttribution: {
          issue: {
            tracker: "github",
            host: "github.com",
            scope: "OWNER/REPO",
            key: "508",
            displayKey: "#508",
            title: "Usage",
            url: managedIssue.url,
          },
          stage: "Plan execution",
        },
      })})
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, run_id, root_node_id, kind, status, payload_json)
      VALUES ('node', 'thread', 'linked-run', 'node', 'root_turn', 'completed', '{}')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts
        (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
      VALUES ('initial', 'thread', 'run', 1, 'node', 'claudeAgent', 'root', 'interrupted', '{"reason":"initial"}'),
        ('retry', 'thread', 'run', 2, 'node', 'claudeAgent', 'root', 'completed', '{"reason":"retry"}')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('message', 'thread', 'run', 'user', 0, ${since}, ${since},
        '{"delegatedCompletion":{"taskIds":["a","b","c"],"batched":true}}')
    `;
      const measured = {
        usageStatus: "complete",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 60,
        cacheCreationTokens: 10,
        requestCount: 2,
        firstInputContext: 40,
        peakInputContext: 60,
      };
      const turn = (
        id: string,
        providerThread: string,
        ordinal: number,
        completedAt: string,
        status: string,
        attempt: string | null,
        payload: Record<string, unknown>,
      ) => sql`
      INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, completed_at, payload_json)
      VALUES (${id}, 'thread', ${providerThread}, 'node', ${attempt}, ${ordinal}, ${status}, ${completedAt}, ${JSON.stringify(payload)})
      ON CONFLICT(provider_turn_id) DO UPDATE SET payload_json = excluded.payload_json
    `;
      yield* turn("before", "root", 1, "2026-11-16T17:59:59.999Z", "completed", null, {
        turnTokenUsage: measured,
      });
      const parent = {
        ...measured,
        hasSubagents: true,
        otherUsage: { inputTokens: 110, outputTokens: 25 },
      };
      yield* turn("at-start", "root", 2, since, "interrupted", "initial", {
        turnTokenUsage: parent,
      });
      yield* turn("at-start", "root", 2, since, "interrupted", "initial", {
        turnTokenUsage: parent,
      });
      yield* turn("retry", "root", 3, since, "completed", "retry", { turnTokenUsage: measured });
      yield* turn("native", "child", 1, "2026-11-16T18:00:01.000Z", "completed", null, {
        turnTokenUsage: measured,
      });
      yield* turn("missing", "codex", 1, since, "failed", null, {});
      yield* turn("local", "root", 4, since, "completed", null, {
        turnTokenUsage: { ...measured, localCommand: true },
      });
      yield* turn("at-end", "root", 5, asOf, "completed", null, { turnTokenUsage: measured });

      const response = yield* budget.read(asOf);
      assert.equal(response.since, since);
      const [claude, codex] = response.providers;
      assert.include(claude?.totals, {
        turns: 3,
        measuredTurns: 3,
        input: 300,
        output: 60,
        cacheRead: 180,
        cacheWrite: 30,
        uncachedInput: 90,
        requests: 6,
        firstContext: 40,
        peakContext: 60,
        residual: 135,
        partialTurns: 1,
        wakes: 1,
        deliveredResults: 3,
      });
      assert.deepEqual(
        claude?.groups.task.map(({ label }) => label),
        ["owner/repo #508 Usage"],
      );
      assert.deepEqual(
        claude?.groups.role.map(({ label }) => label),
        ["Implementor", "Native child"],
      );
      assert.deepEqual(
        claude?.groups.stage.map(({ label }) => label),
        ["Plan execution"],
      );
      assert.deepEqual(
        claude?.groups.wake.map(({ label, totals }) => [label, totals.wakes]),
        [
          ["Batched child results", 1],
          ["Native child", 0],
          ["Retry", 0],
        ],
      );
      assert.include(codex?.totals, {
        turns: 1,
        measuredTurns: 0,
        partialTurns: 1,
        requestCountTurns: 0,
      });
      const report = yield* budget.report(asOf);
      assert.include(report.text, `${since} to ${asOf}`);
      assert.include(
        report.text,
        "owner/repo #508 Usage: 360 tokens, 1 run starts, 3 child results",
      );
    }).pipe(Effect.provide(UsageBudget.layer), Effect.provide(Sqlite.layerMemory)),
);
