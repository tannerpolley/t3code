import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

NodeAssert.equal(
  process.argv.length,
  3,
  "Pass an installed checkout of archive/issue-692-db-compat-proof",
);
const fork = NodePath.resolve(process.argv[2]);
const upstream = NodePath.resolve(import.meta.dirname, "../..");

const now = new Date().toISOString();
const layout = {
  sidebarProjectSections: [
    { id: "section", name: "My projects", projectKeys: ["project"], collapsed: false },
  ],
  projectExpandedById: { project: true },
  projectOrder: ["project"],
  sidebarOtherProjectsExpanded: true,
};
const settings = {
  codexDefaultSpeed: "fast",
  autoUseExpiringResetCredits: true,
  snoozeLimitedThreads: true,
  usageLimitRecovery: "switch",
};

function ledger(sqlite, table) {
  return sqlite
    .prepare(`SELECT migration_id, name FROM ${table} ORDER BY migration_id`)
    .all()
    .map(({ migration_id, name }) => [migration_id, name]);
}

async function load(checkout) {
  const server = NodePath.join(checkout, "apps/server");
  const fromServer = NodeModule.createRequire(NodePath.join(server, "package.json"));
  const source = (file) => import(NodeURL.pathToFileURL(NodePath.join(server, "src", file)).href);
  const dependency = (id) => import(NodeURL.pathToFileURL(fromServer.resolve(id)).href);
  const [
    Effect,
    Layer,
    Option,
    Logger,
    Schema,
    Stream,
    Sqlite,
    contracts,
    migrations,
    events,
    projections,
    projects,
  ] = await Promise.all([
    dependency("effect/Effect"),
    dependency("effect/Layer"),
    dependency("effect/Option"),
    dependency("effect/Logger"),
    dependency("effect/Schema"),
    dependency("effect/Stream"),
    import(
      NodeURL.pathToFileURL(NodePath.join(checkout, "packages/shared/src/nodeSqliteClient.ts")).href
    ),
    import(NodeURL.pathToFileURL(NodePath.join(checkout, "packages/contracts/src/index.ts")).href),
    source("persistence/Migrations.ts"),
    source("persistence/OrchestrationEventStore.ts"),
    source("orchestration-v2/ProjectionStore.ts"),
    source("orchestration-v2/ProjectStore.ts"),
  ]);
  return {
    Effect,
    Layer,
    Option,
    Logger,
    Schema,
    Stream,
    Sqlite,
    contracts,
    migrations,
    events,
    projections,
    projects,
  };
}

function withStores(runtime, db, probe) {
  const { Effect, Layer, Sqlite, events, projections, projects } = runtime;
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* events.OrchestrationEventStore;
      const projection = yield* projections.ProjectionStoreV2;
      const project = yield* projects.ProjectStoreV2;
      return yield* probe({ store, projection, project });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(events.layer, projections.layer, projects.layer).pipe(
          Layer.provide(Sqlite.layer({ filename: db })),
        ),
      ),
    ),
  );
}

async function startServer(checkout, baseDir) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["src/bin.ts", "serve", "--no-browser", "--host", "127.0.0.1", "--base-dir", baseDir],
    {
      cwd: NodePath.join(checkout, "apps/server"),
      env: {
        HOME: baseDir,
        PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
        T3CODE_TELEMETRY_ENABLED: "false",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = NodeEvents.once(child, "close");
  const output = [];
  const ready = new Promise((resolve, reject) => {
    for (const stream of [child.stdout, child.stderr]) {
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        if (line.includes("Database migration history diverges from this build"))
          reject(new Error(line));
        if (line.includes("T3 Code server is ready.")) resolve();
      });
    }
    closed.then(
      ([code, signal]) =>
        reject(
          new Error(`Server exited before readiness (${code ?? signal})\n${output.join("\n")}`),
        ),
      reject,
    );
  });
  let deadline;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Server did not reach readiness")), 30000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGTERM");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, signal] = await closed;
      NodeAssert.notEqual(signal, "SIGKILL", "Server did not shut down");
      NodeAssert.ok(
        [0, 130, 143].includes(code) || signal === "SIGTERM",
        `Shutdown exit code ${code}, signal ${signal}`,
      );
    } finally {
      clearTimeout(watchdog);
    }
  }
}

const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fresh-fork-700-"));
try {
  const data = NodePath.join(root, "userdata");
  const workspace = NodePath.join(root, "project");
  await NodeFSP.mkdir(data);
  await NodeFSP.mkdir(workspace);
  const settingsPath = NodePath.join(data, "settings.json");
  const originalSettings = JSON.stringify(settings);
  await NodeFSP.writeFile(settingsPath, originalSettings);
  const db = NodePath.join(data, "statev2.sqlite");
  const old = await load(fork);
  const fresh = await load(upstream);
  await old.Effect.runPromise(
    old.migrations
      .runMigrations()
      .pipe(
        old.Effect.provide(old.Sqlite.layer({ filename: db })),
        old.Effect.provide(old.Logger.layer([])),
      ),
  );
  const normal = "owner-thread";
  const request = "request-thread";
  const completion = "completion-thread";
  const completionMessage = {
    id: `${completion}-message`,
    text: "Issue worker finished.",
    attachments: [
      { type: "file", id: "report", name: "report.txt", mimeType: "text/plain", sizeBytes: 15 },
    ],
  };
  const requestId = "app-request";
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      options: [{ label: "All", description: "Everything" }],
    },
  ];
  await withStores(old, db, function* ({ store, projection, project }) {
    const projectEvent = yield* store.appendProjectEvent({
      type: "project.created",
      eventId: "project-created",
      aggregateKind: "project",
      aggregateId: "project",
      occurredAt: now,
      commandId: "create-project",
      causationEventId: null,
      correlationId: "create-project",
      metadata: {},
      payload: {
        projectId: "project",
        title: "Owner project",
        workspaceRoot: workspace,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* project.apply(projectEvent);
    const decode = old.Schema.decodeUnknownSync(old.contracts.OrchestrationV2DomainEventJson);
    for (const threadId of [normal, request, completion]) {
      const event = (type, id, payload) => ({ id, type, threadId, occurredAt: now, payload });
      const inputs = [
        event("thread.created", `${threadId}-created`, {
          id: threadId,
          projectId: "project",
          title: threadId,
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          titleSource: "user",
        }),
        event("message.updated", `${threadId}-message`, {
          id: `${threadId}-message`,
          threadId,
          runId: null,
          nodeId: `${threadId}-message-node`,
          role: "assistant",
          text: "Keep this conversation",
          createdBy: "user",
          creationSource: "web",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          ...(threadId === completion
            ? {
                ...completionMessage,
                createdBy: "agent",
                creationSource: "server",
                delegatedCompletion: { parentRunId: null, generation: 1, taskIds: ["worker"] },
              }
            : {}),
        }),
      ];
      const message = inputs[1].payload;
      const placement = {
        threadId,
        runId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        startedAt: now,
        completedAt: now,
        status: "completed",
      };
      inputs.push(
        event("node.updated", `${threadId}-message-node-event`, {
          ...placement,
          id: message.nodeId,
          parentNodeId: null,
          rootNodeId: message.nodeId,
          kind: "assistant_message",
          countsForRun: false,
          runtimeRequestId: null,
          checkpointScopeId: null,
        }),
        event("turn-item.updated", `${threadId}-message-item-event`, {
          ...placement,
          id: `${threadId}-message-item`,
          nodeId: message.nodeId,
          parentItemId: null,
          ordinal: 1,
          title: null,
          updatedAt: now,
          type: "assistant_message",
          messageId: message.id,
          text: message.text,
          streaming: false,
        }),
      );
      if (threadId === normal) {
        inputs.splice(
          1,
          0,
          event("thread.quiet-updated", "quiet-event", {
            runId: "historical-run",
            lastProviderActivityAt: Date.parse(now),
          }),
        );
      }
      if (threadId === request) {
        const nodeId = "request-node";
        const placement = {
          threadId,
          runId: null,
          providerThreadId: null,
          providerTurnId: "historical-provider-turn",
          nativeItemRef: null,
          startedAt: now,
          completedAt: now,
          status: "completed",
        };
        inputs.push(
          event("node.updated", "request-node-event", {
            ...placement,
            id: nodeId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            countsForRun: false,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
          }),
          event("runtime-request.updated", "pending-request-event", {
            id: requestId,
            nodeId,
            providerTurnId: placement.providerTurnId,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "app_owned", providerSessionId: "session" },
            createdAt: now,
            resolvedAt: null,
          }),
          event("runtime-request.updated", "request-event", {
            id: requestId,
            nodeId,
            providerTurnId: placement.providerTurnId,
            nativeRequestRef: null,
            kind: "user_input",
            status: "resolved",
            responseCapability: { type: "app_owned", providerSessionId: "session" },
            createdAt: now,
            resolvedAt: now,
            answers: { scope: ["All"] },
          }),
          event("turn-item.updated", "request-item-event", {
            ...placement,
            id: "request-item",
            nodeId,
            parentItemId: null,
            ordinal: 2,
            title: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions,
          }),
        );
      }
      const events = inputs.map(decode);
      yield* store.appendAgentEvents({ events });
      for (const event of events) yield* projection.apply(event);
    }
  });
  let forkLedger;
  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    NodeAssert.deepEqual(ledger(sqlite, "effect_sql_migrations"), old.migrations.migrationManifest);
    forkLedger = ledger(sqlite, "t3_fork_migrations");
    NodeAssert.equal(forkLedger.length, 37);
    sqlite
      .prepare("INSERT INTO sidebar_layout (id, revision, layout_json) VALUES (1, 1, ?)")
      .run(JSON.stringify(layout));
    sqlite.exec(
      "INSERT INTO issue_thread_links VALUES ('github.com', 'example/project', 700, 'owner-thread')",
    );
  }

  const command = (mode) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "convert-database.mjs"), mode, data],
      { encoding: "utf8" },
    );
  const success = (mode) => {
    const result = command(mode);
    NodeAssert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const refuse = (mode, reason) => {
    const result = command(mode);
    NodeAssert.equal(result.status, 1, result.stdout);
    NodeAssert.match(result.stderr, reason);
    return result.stdout;
  };
  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    sqlite.exec("UPDATE t3_fork_migrations SET name = 'different' WHERE migration_id = 1");
    refuse("convert", /Unexpected t3_fork_migrations history/);
    sqlite.exec(
      "UPDATE t3_fork_migrations SET name = 'ProjectionMessagesLatestAssistant' WHERE migration_id = 1",
    );
    sqlite.exec(`UPDATE orchestration_v2_projection_runtime_requests
      SET status = 'pending', payload_json = json_set(payload_json, '$.status', 'pending')`);
    const report = JSON.parse(refuse("convert", /Preflight refused/));
    NodeAssert.equal(report.blockers.unresolvedAppRequests, 1);
    sqlite.exec(`UPDATE orchestration_v2_projection_runtime_requests
      SET status = 'resolved', payload_json = json_set(payload_json, '$.status', 'resolved')`);
    sqlite.exec(`INSERT INTO orchestration_v2_effect_outbox
      (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES ('effect', 'command', 'owner-thread', 'issue.github.comment', '{}', 'pending',
        current_timestamp, current_timestamp, current_timestamp)`);
    NodeAssert.equal(
      JSON.parse(refuse("convert", /Preflight refused/)).blockers.pendingForkEffects,
      1,
    );
    sqlite.exec(
      "UPDATE orchestration_v2_effect_outbox SET status = 'cancelled' WHERE effect_id = 'effect'",
    );
    NodeAssert.equal(
      sqlite
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 't3_fresh_fork_%'")
        .get().n,
      0,
    );
    using owner = new NodeSqlite.DatabaseSync(NodePath.join(data, "server-owner.sqlite"));
    owner.exec("BEGIN EXCLUSIVE");
    refuse("convert", /database is locked/);
  }

  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    const verifyBlocked = (name) => {
      const report = JSON.parse(refuse("dry-run", /Preflight refused/));
      NodeAssert.equal(report.blockers[name], 1, name);
    };
    const setRoot = (configuration) =>
      sqlite
        .prepare(`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.repositoryOrchestration', json(?))
      WHERE thread_id = ?`)
        .run(JSON.stringify(configuration), normal);
    setRoot({ restore: { requestId: "restore" } });
    verifyBlocked("repositoryRestores");
    setRoot({});
    sqlite.exec(`INSERT INTO scheduled_tasks
      (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json,
       model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at,
       updated_at, last_run_status, run_count)
      VALUES ('task', 'Task', 'Prompt', 1, '{"type":"interval","everyMs":60000}', 'project', 'owner-thread',
        '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', 'user',
        'web', current_timestamp, current_timestamp, 'never', 0)`);
    verifyBlocked("forkSchedules");
    sqlite.exec(`UPDATE scheduled_tasks SET thread_id = NULL;
      UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.repositoryOrchestration')
      WHERE thread_id = 'owner-thread'`);
    NodeAssert.equal(JSON.parse(success("dry-run")).blockers.forkSchedules, 0);

    sqlite.exec(`INSERT INTO issue_inbox_digests(host, repository_id, text, created_at)
        VALUES ('github.com', 'repository-id', 'Digest', current_timestamp);
      INSERT INTO issue_inbox_events (host, repository_id, repository, event_key, issue_number,
        issue_title, kind, tagged, high_priority, needs_triage, url, snippet, occurred_at, digest_id)
        VALUES ('github.com', 'repository-id', 'example/project', 'key', 700, 'Issue', 'comment',
          1, 0, 0, 'https://example.test', 'Comment', current_timestamp, NULL)`);
    verifyBlocked("pendingInboxDigestEvents");
    sqlite.exec("UPDATE issue_inbox_events SET digest_id = 1");
    verifyBlocked("pendingInboxDigestEvents");
    sqlite.exec("UPDATE issue_inbox_digests SET delivered_at = current_timestamp");

    sqlite.exec(`INSERT INTO inline_shell_runs (thread_id, block_id, run_id, status, record_json)
      VALUES ('owner-thread', 'block', 'shell-run', 'completed', '{}')`);
    verifyBlocked("pendingInlineShellDeliveries");
    sqlite.exec("UPDATE inline_shell_runs SET delivered_by = 'delivery'");

    sqlite.exec(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('failed', 'owner-thread', 1, 'codex', 'codex', 'failed', current_timestamp, current_timestamp,
        '{"modelSelection":{"instanceId":"codex","model":"gpt-5"},"rootNodeId":"failure-node"}');
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('failed-item', 'owner-thread', 'failed', 'failure-node', 1, 'error', 'failed',
          current_timestamp, '{"failure":{"class":"usage_limit"}}')`);
    verifyBlocked("pendingProviderSwitches");
    sqlite.exec(`UPDATE orchestration_v2_projection_threads
      SET provider_instance_id = 'claudeAgent', payload_json = json_set(payload_json,
        '$.modelSelection', json('{"instanceId":"claudeAgent","model":"claude"}'),
        '$.autoProviderSwitch', json('{"runId":"failed","to":{"instanceId":"claudeAgent","model":"claude"}}'))
      WHERE thread_id = 'owner-thread'`);
    verifyBlocked("pendingProviderSwitches");
    sqlite.exec(`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES ('continuation', 'owner-thread', 2, 'claudeAgent', 'claudeAgent', 'queued', current_timestamp,
        NULL, '{"userMessageId":"limit-switch-resume:owner-thread:failed"}');
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('limit-switch-resume:owner-thread:failed', 'owner-thread', 'continuation', 'user', 0,
        current_timestamp, current_timestamp, '{}')`);
    const settled = JSON.parse(success("dry-run")).blockers;
    for (const name of [
      "repositoryRestores",
      "pendingInboxDigestEvents",
      "pendingInlineShellDeliveries",
      "pendingProviderSwitches",
    ]) {
      NodeAssert.equal(settled[name], 0, name);
    }
    sqlite.exec(`DELETE FROM orchestration_v2_projection_runs;
      DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'failed-item';
      DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'limit-switch-resume:owner-thread:failed';
      UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'codex',
        payload_json = json_set(json_remove(payload_json, '$.autoProviderSwitch'),
          '$.modelSelection', json('{"instanceId":"codex","model":"gpt-5"}'))
      WHERE thread_id = 'owner-thread';
      INSERT INTO orchestration_v2_projection_thread_references VALUES ('owner-thread', 'archived-reference')`);
  }

  async function readThreads(runtime) {
    return withStores(runtime, db, function* ({ store, projection, project }) {
      NodeAssert.equal(
        runtime.Option.getOrThrow(yield* project.get("project")).title,
        "Owner project",
      );
      const results = [];
      for (const threadId of [normal, request, completion]) {
        const { projection: full } = yield* projection.getThreadSnapshot(threadId);
        const { projection: bounded } = yield* projection.getThreadSnapshotWindow(threadId, {
          rowLimit: 20,
        });
        const replay = Array.from(
          yield* store.readAgentEvents({ threadId }).pipe(runtime.Stream.runCollect),
        );
        for (const snapshot of [full, bounded]) {
          NodeAssert.equal(snapshot.thread.id, threadId);
          NodeAssert.equal(snapshot.thread.title, threadId);
          if (threadId === request) {
            const [request] = snapshot.runtimeRequests;
            NodeAssert.equal(
              request.responseCapability.type,
              runtime === old ? "app_owned" : "not_resumable",
            );
            NodeAssert.deepEqual(request.answers, { scope: ["All"] });
            NodeAssert.deepEqual(
              snapshot.turnItems.find((item) => item.id === "request-item")?.questions,
              questions,
            );
          }
          const [message] = snapshot.messages;
          if (threadId === completion) {
            const { id, text, attachments, delegatedCompletion } = message;
            NodeAssert.deepEqual({ id, text, attachments }, completionMessage);
            NodeAssert.equal(delegatedCompletion?.parentRunId, runtime === old ? null : undefined);
          } else {
            NodeAssert.equal(message.text, "Keep this conversation");
          }
          results.push(
            snapshot.messages.map(({ id, text, attachments }) => ({ id, text, attachments })),
          );
        }
        if (threadId === request) {
          const history = replay.filter(({ event }) => event.type === "runtime-request.updated");
          NodeAssert.deepEqual(
            history.map(({ event }) => event.payload.status),
            ["pending", "resolved"],
          );
          for (const { event } of history) {
            NodeAssert.equal(
              event.payload.responseCapability.type,
              runtime === old ? "app_owned" : "not_resumable",
            );
          }
        }
        if (threadId === completion) {
          const event = replay.find(({ event }) => event.type === "message.updated");
          NodeAssert.equal(
            event?.event.payload.delegatedCompletion?.parentRunId,
            runtime === old ? null : undefined,
          );
        }
        const nativeReplay =
          runtime === old
            ? replay.filter(({ event }) => event.type !== "thread.quiet-updated")
            : replay;
        results.push(nativeReplay.map(({ sequence, event }) => [sequence, event.id, event.type]));
      }
      return results;
    });
  }

  const before = await readThreads(old);
  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    for (const type of [
      "issue.work.cancelled",
      "repository.work.restored",
      "issue.work.requested",
      "issue.queue.updated",
      "issue.github-comment.recorded",
      "run-attempt.skill-preload-recorded",
    ]) {
      sqlite
        .prepare(`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind,
          payload_json, metadata_json, application_event_version)
        VALUES (?, 'thread', ?, (SELECT max(stream_version) + 1 FROM orchestration_events WHERE stream_id = ?),
          ?, ?, 'server', '{}', '{}', 2)`)
        .run(type, normal, normal, type, now);
    }
  }
  const oldHead = await withStores(old, db, function* ({ store, projection }) {
    const cursor = yield* store.latestAgentSequence(normal);
    NodeAssert.equal((yield* projection.getThreadSnapshot(normal)).snapshotSequence, cursor);
    NodeAssert.equal(
      (yield* projection.getThreadSnapshotWindow(normal, { rowLimit: 20 })).snapshotSequence,
      cursor,
    );
    return cursor;
  });
  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    sqlite.exec(`UPDATE orchestration_v2_projection_threads SET payload_json =
      json_set(payload_json, '$.runtimeMode', 'invalid') WHERE thread_id = 'completion-thread'`);
    refuse("convert", /Failed to read|Failed to load|Could not read/);
    NodeAssert.equal(
      sqlite
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 't3_fresh_fork_%'")
        .get().n,
      0,
    );
    NodeAssert.equal(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM orchestration_events WHERE event_type = 'thread.quiet-updated' AND application_event_version = 2",
        )
        .get().n,
      1,
    );
    sqlite.exec(`UPDATE orchestration_v2_projection_threads SET payload_json =
      json_set(payload_json, '$.runtimeMode', 'full-access') WHERE thread_id = 'completion-thread'`);
  }
  const report = JSON.parse(success("dry-run"));
  NodeAssert.equal(report.counts.events.withheld, 7);
  NodeAssert.equal(report.counts.events.requestEvents, 2);
  NodeAssert.equal(report.counts.events.completionEvents, 1);
  NodeAssert.deepEqual(report.settingsKeys, ["codexDefaultSpeed", "autoUseExpiringResetCredits"]);
  const conversion = JSON.parse(success("convert").trimEnd().split("\n").at(-1));
  NodeAssert.deepEqual(conversion, { converted: true, verifiedThreads: 3 });
  refuse("convert", /already converted/);
  {
    using sqlite = new NodeSqlite.DatabaseSync(db, { readOnly: true });
    NodeAssert.deepEqual(ledger(sqlite, "effect_sql_migrations"), old.migrations.migrationManifest);
    NodeAssert.deepEqual(ledger(sqlite, "t3_fork_migrations"), forkLedger);
  }
  await startServer(upstream, root);
  NodeAssert.deepEqual(await readThreads(fresh), before);
  const { decideThreadResume } =
    await import("../../apps/server/src/orchestration-v2/ThreadStream.ts");
  await withStores(fresh, db, function* ({ store, projection }) {
    const snapshot = yield* projection.getThreadSnapshot(normal);
    const highWater = yield* store.latestAgentSequence(normal);
    NodeAssert.equal(snapshot.snapshotSequence, highWater);
    NodeAssert.equal(
      (yield* projection.getThreadSnapshotWindow(normal, { rowLimit: 20 })).snapshotSequence,
      highWater,
    );
    NodeAssert.ok(highWater < oldHead);
    NodeAssert.deepEqual(
      decideThreadResume({
        afterSequence: oldHead,
        highWater,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
      { mode: "snapshot" },
    );

    const event = {
      type: "thread.metadata-updated",
      id: "fresh-mutation",
      threadId: normal,
      occurredAt: fresh.Schema.decodeUnknownSync(fresh.Schema.DateTimeUtcFromString)(now),
      payload: { ...snapshot.projection.thread, title: "Updated after cutover" },
    };
    const [stored] = yield* store.appendAgentEvents({ events: [event] });
    yield* projection.apply(stored.event);
    NodeAssert.ok(stored.sequence > oldHead);
    NodeAssert.equal(
      (yield* projection.getThreadSnapshot(normal)).projection.thread.title,
      "Updated after cutover",
    );
  });

  const persisted = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
  NodeAssert.equal(persisted.snoozeLimitedThreads, true);
  NodeAssert.equal(Object.hasOwn(persisted, "codexDefaultSpeed"), false);
  NodeAssert.equal(Object.hasOwn(persisted, "autoUseExpiringResetCredits"), false);
  success("restore-settings");
  NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(settingsPath, "utf8")), {
    ...persisted,
    codexDefaultSpeed: "fast",
    autoUseExpiringResetCredits: true,
  });
  {
    using sqlite = new NodeSqlite.DatabaseSync(db, { readOnly: true });
    NodeAssert.deepEqual(
      ledger(sqlite, "effect_sql_migrations"),
      fresh.migrations.migrationManifest,
    );
    NodeAssert.deepEqual(ledger(sqlite, "t3_fork_migrations"), forkLedger);
    NodeAssert.deepEqual(
      {
        ...sqlite
          .prepare(
            "SELECT * FROM orchestration_v2_projection_thread_references WHERE owner_thread_id = ?",
          )
          .get(normal),
      },
      {
        owner_thread_id: normal,
        referenced_thread_id: "archived-reference",
      },
    );
    NodeAssert.equal(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND (name GLOB 'orchestration_v2_quiet_*' OR name GLOB 'orchestration_v2_thread_references_*')",
        )
        .get().n,
      0,
    );
    NodeAssert.deepEqual(
      JSON.parse(sqlite.prepare("SELECT layout_json FROM sidebar_layout").get().layout_json),
      layout,
    );
    NodeAssert.equal(
      sqlite.prepare("SELECT thread_id FROM issue_thread_links WHERE issue_number = 700").get()
        .thread_id,
      normal,
    );
    NodeAssert.equal(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM t3_fresh_fork_event_archive WHERE application_event_version = 2",
        )
        .get().n,
      7,
    );
  }
  console.log(
    "PASS preflight refusals, offline lock, read-only counts, verification rollback, upstream boot, full and bounded reads, replay cursor fallback, archival preservation, and settings restore",
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
