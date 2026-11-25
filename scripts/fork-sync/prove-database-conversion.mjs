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
  const report = JSON.parse(success("dry-run"));
  NodeAssert.equal(report.counts.events.withheld, 7);
  NodeAssert.equal(report.counts.events.requestEvents, 2);
  NodeAssert.equal(report.counts.events.completionEvents, 1);
  NodeAssert.deepEqual(report.settingsKeys, ["codexDefaultSpeed", "autoUseExpiringResetCredits"]);
  success("convert");
  refuse("convert", /already converted/);
  await startServer(upstream, root);
  NodeAssert.deepEqual(await readThreads(fresh), before);

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
    "PASS ledger and pending-work refusals, offline lock, dry-run counts, conversion, upstream boot, strict replay, full and bounded reads, and settings restore",
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
