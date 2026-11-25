// Run with the pinned Node from the fork root. Native subprocesses and resolution
// keep each server and its workspace dependencies in its own checkout.
// node scripts/fork-sync/prove-database-compatibility.mjs /path/to/upstream-checkout
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

NodeAssert.equal(process.argv.length, 3, "Pass the path to an installed upstream checkout");
const fork = NodePath.resolve(import.meta.dirname, "../..");
const upstream = NodePath.resolve(process.argv[2]);

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
  worktreesDirectory: "project-local",
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
  let divergentHistory = false;
  const ready = new Promise((resolve, reject) => {
    for (const stream of [child.stdout, child.stderr]) {
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        if (line.includes("Database migration history diverges from this build"))
          divergentHistory = true;
        if (line.includes("T3 Code server is ready.")) resolve();
      });
    }
    closed.then(
      ([code, signal]) => reject(new Error(`Server exited before readiness (${code ?? signal})`)),
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
    return divergentHistory;
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

const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fresh-fork-692-"));
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
    old.migrations.runMigrations().pipe(old.Effect.provide(old.Sqlite.layer({ filename: db }))),
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
          nodeId: null,
          role: "user",
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
            ordinal: 1,
            title: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which scope?",
                options: [{ label: "All", description: "Everything" }],
              },
            ],
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
    sqlite
      .prepare(`INSERT INTO workflow_runs (
      run_id, workflow, version, engine_tag, idempotency_key, title, status, started_at, updated_at, ended_at, input_json
    ) VALUES ('skipped', 'fixture', 1, 'fixture', 'skipped', 'Fixture run', 'skipped', ?, ?, ?, '{"keep":"input"}')`)
      .run(now, now, now);
  }

  NodeAssert.equal(await startServer(upstream, root), false);
  const persisted = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
  NodeAssert.equal(persisted.snoozeLimitedThreads, true);
  NodeAssert.equal(persisted.worktreesDirectory, "project-local");
  NodeAssert.equal(Object.hasOwn(persisted, "codexDefaultSpeed"), false);
  NodeAssert.equal(Object.hasOwn(persisted, "autoUseExpiringResetCredits"), false);
  {
    using sqlite = new NodeSqlite.DatabaseSync(db, { readOnly: true });
    const nativeLedger = ledger(sqlite, "effect_sql_migrations");
    NodeAssert.equal(nativeLedger.length, 119);
    NodeAssert.deepEqual(nativeLedger, fresh.migrations.migrationManifest);
    NodeAssert.deepEqual(ledger(sqlite, "t3_fork_migrations"), forkLedger);
    NodeAssert.deepEqual(
      {
        ...sqlite
          .prepare("SELECT status, input_json FROM workflow_runs WHERE run_id = 'skipped'")
          .get(),
      },
      {
        status: "skipped",
        input_json: null,
      },
    );
    NodeAssert.deepEqual(
      JSON.parse(sqlite.prepare("SELECT layout_json FROM sidebar_layout").get().layout_json),
      layout,
    );
  }
  console.log(
    "PASS upstream server ready; native ledger 119, fork ledger 37 and sidebar layout preserved",
  );

  console.log(
    "PASS migration 113 clears skipped workflow input; startup rewrites settings.json without the two kept preferences",
  );

  await withStores(fresh, db, function* ({ store, projection, project }) {
    NodeAssert.equal(fresh.Option.getOrThrow(yield* project.get("project")).title, "Owner project");
    const { projection: thread } = yield* projection.getThreadSnapshot(normal);
    NodeAssert.equal(thread.thread.title, normal);
    NodeAssert.equal(Object.hasOwn(thread.thread, "titleSource"), false);
    NodeAssert.equal(thread.messages[0]?.text, "Keep this conversation");
    const read = (threadId, skipUnknownEventTypes) =>
      store.readAgentEvents({ threadId, skipUnknownEventTypes }).pipe(fresh.Stream.runCollect);
    const unknownType = yield* fresh.Effect.flip(read(normal, false));
    NodeAssert.match(String(unknownType.cause), /at \["type"\]/);
    const supported = Array.from(yield* read(normal, true), ({ event }) => event.type);
    NodeAssert.deepEqual(supported, ["thread.created", "message.updated"]);
    const invalidReplay = yield* fresh.Effect.flip(read(request, true));
    NodeAssert.match(String(invalidReplay.cause), /responseCapability/);
    const invalidSnapshot = yield* fresh.Effect.flip(projection.getThreadSnapshot(request));
    NodeAssert.match(
      String(invalidSnapshot.cause?.cause ?? invalidSnapshot.cause),
      /responseCapability/,
    );
    const invalidWindow = yield* fresh.Effect.flip(
      projection.getThreadSnapshotWindow(request, { rowLimit: 20 }),
    );
    NodeAssert.match(
      String(invalidWindow.cause?.cause ?? invalidWindow.cause),
      /responseCapability/,
    );
    const invalidCompletionReplay = yield* fresh.Effect.flip(read(completion, true));
    NodeAssert.match(String(invalidCompletionReplay.cause), /parentRunId/);
    const invalidCompletionSnapshot = yield* fresh.Effect.flip(
      projection.getThreadSnapshot(completion),
    );
    NodeAssert.match(
      String(invalidCompletionSnapshot.cause?.cause ?? invalidCompletionSnapshot.cause),
      /parentRunId/,
    );
  });
  console.log(
    "PASS ordinary history survives; strict replay rejects fork events and client replay skips unknown types only",
  );
  console.log(
    "PASS app_owned request breaks full and bounded reads and replay; null completion parent breaks full reads and replay",
  );

  const decode = fresh.Schema.decodeUnknownSync;
  const decodedSettings = decode(fresh.contracts.ServerSettings)(settings);
  NodeAssert.equal(decodedSettings.snoozeLimitedThreads, true);
  NodeAssert.equal(Object.hasOwn(decodedSettings, "codexDefaultSpeed"), false);
  NodeAssert.equal(Object.hasOwn(decodedSettings, "autoUseExpiringResetCredits"), false);
  NodeAssert.equal(decodedSettings.worktreesDirectory, "project-local");
  const { resolveWorktreesDirectory } = await import(
    NodeURL.pathToFileURL(NodePath.join(upstream, "apps/server/src/worktreesDirectory.ts")).href
  );
  NodeAssert.equal(
    resolveWorktreesDirectory(decodedSettings.worktreesDirectory, "/default", NodePath, root),
    null,
  );
  const clientSettings = decode(fresh.contracts.ClientSettingsSchema)({
    confirmThreadDelete: false,
    sidebarTogglePosition: "right",
  });
  NodeAssert.equal(clientSettings.confirmThreadDelete, false);
  NodeAssert.equal(Object.hasOwn(clientSettings, "sidebarTogglePosition"), false);
  const projectConfig = decode(fresh.contracts.T3ProjectFile)({
    defaultThreadEnvMode: "worktree",
    roleSkills: { reviewer: ["plugin:skill"] },
    issueWorktreeKeepPaths: [".venv"],
  });
  NodeAssert.deepEqual(projectConfig, { defaultThreadEnvMode: "worktree" });
  const { parsePersistedState, persistState } = await import(
    NodeURL.pathToFileURL(NodePath.join(upstream, "apps/web/src/uiStateStore.ts")).href
  );
  const parsed = parsePersistedState(layout);
  NodeAssert.deepEqual(parsed.projectOrder, ["project"]);
  NodeAssert.deepEqual(parsed.projectExpandedById, { project: true });
  NodeAssert.equal(Object.hasOwn(parsed, "sidebarProjectSections"), false);
  let stored;
  globalThis.window = {
    localStorage: {
      setItem: (_, value) => {
        stored = value;
      },
      removeItem: () => {},
    },
  };
  try {
    persistState(parsed);
    NodeAssert.equal(Object.hasOwn(JSON.parse(stored), "sidebarProjectSections"), false);
  } finally {
    delete globalThis.window;
  }
  console.log(
    "PASS upstream settings, t3.json and client storage retain native keys and omit fork-only fields",
  );

  NodeAssert.equal(await startServer(fork, root), true);
  await withStores(old, db, function* ({ store, projection }) {
    const snapshot = yield* projection.getThreadSnapshot(request);
    NodeAssert.equal(snapshot.projection.messages[0]?.text, "Keep this conversation");
    const rows = Array.from(
      yield* store.readAgentEvents({ threadId: request }).pipe(old.Stream.runCollect),
    );
    NodeAssert.equal(
      rows.find(({ event }) => event.type === "runtime-request.updated")?.event.payload
        .responseCapability.type,
      "app_owned",
    );
  });
  console.log(
    "PASS fork server reopens the upstream-migrated fixture and reads the original request",
  );

  {
    using sqlite = new NodeSqlite.DatabaseSync(db);
    const capability = JSON.stringify({ type: "not_resumable", reason: "Historical T3 request" });
    sqlite
      .prepare(
        "UPDATE orchestration_v2_projection_runtime_requests SET payload_json = json_set(payload_json, '$.responseCapability', json(?)) WHERE runtime_request_id = ?",
      )
      .run(capability, requestId);
    sqlite
      .prepare(
        "UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.responseCapability', json(?)) WHERE event_id = 'request-event'",
      )
      .run(capability);
    for (const [table, id] of [
      ["orchestration_v2_projection_messages", "message_id"],
      ["orchestration_events", "event_id"],
    ]) {
      sqlite
        .prepare(
          `UPDATE ${table} SET payload_json = json_remove(payload_json, '$.delegatedCompletion') WHERE ${id} = ?`,
        )
        .run(completionMessage.id);
    }
  }
  await withStores(fresh, db, function* ({ store, projection }) {
    const snapshot = yield* projection.getThreadSnapshot(request);
    NodeAssert.equal(
      snapshot.projection.runtimeRequests[0]?.responseCapability.type,
      "not_resumable",
    );
    NodeAssert.equal(snapshot.projection.messages[0]?.text, "Keep this conversation");
    const rows = Array.from(
      yield* store.readAgentEvents({ threadId: request }).pipe(fresh.Stream.runCollect),
    );
    NodeAssert.equal(
      rows.find(({ event }) => event.type === "runtime-request.updated")?.event.payload
        .responseCapability.type,
      "not_resumable",
    );
    const window = yield* projection.getThreadSnapshotWindow(request, { rowLimit: 20 });
    const [restored] = window.projection.runtimeRequests;
    NodeAssert.equal(restored.responseCapability.type, "not_resumable");
    NodeAssert.deepEqual(restored.answers, { scope: ["All"] });
    NodeAssert.ok(
      window.projection.turnItems.some(
        (item) => item.type === "user_input_request" && item.requestId === requestId,
      ),
    );
    const completionSnapshot = yield* projection.getThreadSnapshot(completion);
    const completionHistory = Array.from(
      yield* store
        .readAgentEvents({ threadId: completion, skipUnknownEventTypes: true })
        .pipe(fresh.Stream.runCollect),
    );
    for (const message of [
      completionSnapshot.projection.messages[0],
      completionHistory.at(-1)?.event.payload,
    ]) {
      const { id, text, attachments, delegatedCompletion } = message;
      NodeAssert.deepEqual({ id, text, attachments }, completionMessage);
      NodeAssert.equal(delegatedCompletion, undefined);
    }
  });
  console.log(
    "PASS both conversions restore reads and replay while preserving the question, answer, and completion message",
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
