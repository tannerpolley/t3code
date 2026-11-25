import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const events = "orchestration_events";
const threads = "orchestration_v2_projection_threads";
const requests = "orchestration_v2_projection_runtime_requests";
const messages = "orchestration_v2_projection_messages";
const archive = "t3_fresh_fork_event_archive";
const settingsExport = "t3_fresh_fork_settings_export";
const keptSettings = ["codexDefaultSpeed", "autoUseExpiringResetCredits"];

// Fingerprints of ordered (id, name) pairs from archive/issue-692-db-compat-proof.
// The installed fork ends at 36. The final fork source and synthetic fixture end at 37.
const ledgers = {
  effect_sql_migrations: {
    111: "c1556cdd3c4b50cffc14c434bc12ca8989708c89d145a6c75dc8f31649ac2aa4",
  },
  t3_fork_migrations: {
    36: "1fb222b03abdf267fccf327ccf0c261d8b2308d3881da3ed1cd8f4aece837af3",
    37: "3034b90684534a7c3b4b6b0856f16e03b4009add0cf2c973be03df77abb711db",
  },
};

const forkEvents = [
  "thread.quiet-updated",
  "issue.work.cancelled",
  "repository.work.restored",
  "issue.work.requested",
  "issue.queue.updated",
  "issue.github-comment.recorded",
  "run-attempt.skill-preload-recorded",
];
const appEvent = "aggregate_kind = 'thread' AND application_event_version = 2";
const appOwned = "json_extract(payload_json, '$.responseCapability.type') = 'app_owned'";
const nullParent = "json_type(payload_json, '$.delegatedCompletion.parentRunId') = 'null'";
const normalizedRequest = `json_set(payload_json, '$.responseCapability',
  json('{"type":"not_resumable","reason":"Historical app-owned request"}'))`;
const normalizedMessage = "json_remove(payload_json, '$.delegatedCompletion')";
const conversions = {
  requestEvents: [
    events,
    "stream_id",
    `${appEvent} AND event_type = 'runtime-request.updated' AND ${appOwned}`,
    normalizedRequest,
  ],
  requestProjections: [requests, "thread_id", appOwned, normalizedRequest],
  completionEvents: [
    events,
    "stream_id",
    `${appEvent} AND event_type = 'message.updated' AND ${nullParent}`,
    normalizedMessage,
  ],
  completionProjections: [messages, "thread_id", nullParent, normalizedMessage],
};

const runs = "orchestration_v2_projection_runs";
const managedThread = (id) => `EXISTS (SELECT 1 FROM ${threads} thread
  WHERE thread.thread_id = ${id} AND thread.deleted_at IS NULL AND (
    json_type(thread.payload_json, '$.linkedIssue') = 'object'
    OR EXISTS (SELECT 1 FROM orchestration_v2_projection_issue_work claim
      WHERE claim.owner_thread_id = thread.thread_id)
    OR EXISTS (SELECT 1 FROM orchestration_v2_projection_repository_orchestration owner
      WHERE owner.root_thread_id IN (thread.thread_id, json_extract(thread.payload_json, '$.lineage.rootThreadId')))
  ))`;

const blockers = {
  unresolvedAppRequests: [
    requests,
    `${appOwned} AND (
    status NOT IN ('resolved', 'expired', 'cancelled')
    OR json_extract(payload_json, '$.status') IS NOT status)`,
  ],
  pendingForkEffects: [
    "orchestration_v2_effect_outbox",
    `status IN ('pending', 'running') AND
    (effect_type LIKE 'issue.%' OR effect_type IN ('run.silence.check',
      'repository.handoff-completion', 'usage-sprint.notify'))`,
  ],
  ownerDecisions: [
    "owner_decisions",
    `state IN ('publishing', 'awaiting_choice') OR pending_publish IS NOT NULL
    OR pending_delivery = 1 OR pending_label = 1`,
  ],
  issueChanges: [
    "issue_changes",
    `status IN ('pending', 'queued', 'executing', 'needs_attention')
    OR in_flight_step IS NOT NULL`,
  ],
  issueRequests: [
    "orchestration_v2_projection_issue_work_requests",
    `queue_state IN ('queued', 'needs_attention') OR
    (queue_state IS NULL AND json_type(payload_json, '$.cancellation') IS NULL
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_issue_work work
        WHERE work.host = entry.host AND work.repository_id = entry.repository_id AND work.issue_id = entry.issue_id
          AND work.owner_thread_id IS NOT NULL AND work.owner_thread_id <> entry.attempt_key))`,
  ],
  repositoryHandoffs: [
    threads,
    `json_type(payload_json, '$.repositoryOrchestration.handoff') = 'object'
    OR json_extract(payload_json, '$.repositoryOrchestration.automaticHandoff.status') = 'verifying'`,
  ],
  repositoryRestores: [
    threads,
    "json_type(payload_json, '$.repositoryOrchestration.restore') = 'object'",
  ],
  managedRuns: [
    runs,
    `status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    AND ${managedThread("entry.thread_id")}`,
  ],
  managedDelegations: [
    "orchestration_v2_projection_subagents",
    `origin = 'app_owned'
    AND (status IN ('pending', 'running', 'waiting') OR completion_delivery_state IN ('pending', 'claimed'))
    AND (${managedThread("entry.thread_id")} OR ${managedThread("entry.child_thread_id")})`,
  ],
  managedProviderRequests: [
    requests,
    `status = 'pending' AND NOT (${appOwned})
    AND ${managedThread("entry.thread_id")}`,
  ],
  forkSchedules: [
    "scheduled_tasks",
    `repository_target_json IS NOT NULL OR action IS NOT 'prompt'
    OR EXISTS (SELECT 1 FROM ${threads} thread
      WHERE thread.thread_id = entry.thread_id
        AND json_type(thread.payload_json, '$.repositoryOrchestration') = 'object')`,
  ],
  runningInlineShells: ["inline_shell_runs", "status = 'running'"],
  pendingInlineShellDeliveries: [
    "inline_shell_runs",
    `status <> 'running' AND delivered_by IS NULL
    AND EXISTS (SELECT 1 FROM ${threads} thread WHERE thread.thread_id = entry.thread_id
      AND thread.deleted_at IS NULL)`,
  ],
  pendingInboxDigestEvents: [
    "issue_inbox_events",
    `read_at IS NULL AND EXISTS (
    SELECT 1 FROM issue_inbox_digests digest WHERE digest.digest_id = entry.digest_id AND digest.delivered_at IS NULL)`,
  ],
  pendingProviderSwitches: [
    threads,
    `archived_at IS NULL AND deleted_at IS NULL
    AND json_extract(payload_json, '$.settledOverride') IS NOT 'settled'
    AND json_type(payload_json, '$.autoProviderSwitch.to') = 'object'
    AND json_extract(payload_json, '$.modelSelection.instanceId') IS json_extract(payload_json, '$.autoProviderSwitch.to.instanceId')
    AND json_extract(payload_json, '$.modelSelection.model') IS json_extract(payload_json, '$.autoProviderSwitch.to.model')
    AND coalesce(json_extract(payload_json, '$.modelSelection.options'), '[]')
      IS coalesce(json_extract(payload_json, '$.autoProviderSwitch.to.options'), '[]')
    AND EXISTS (SELECT 1 FROM ${runs} failed
      WHERE failed.run_id = json_extract(entry.payload_json, '$.autoProviderSwitch.runId')
        AND failed.thread_id = entry.thread_id AND failed.status = 'failed'
        AND failed.run_id = (SELECT latest.run_id FROM ${runs} latest
          WHERE latest.thread_id = entry.thread_id AND latest.status <> 'queued'
            AND NOT (latest.status = 'cancelled' AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
          ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC, latest.ordinal DESC, latest.run_id DESC
          LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM ${runs} continuation
          WHERE continuation.thread_id = entry.thread_id
            AND json_extract(continuation.payload_json, '$.userMessageId') =
              'limit-switch-resume:' || entry.thread_id || ':' || failed.run_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers transfer
          WHERE transfer.source_thread_id = entry.thread_id AND transfer.type = 'subagent_result'
            AND json_extract(transfer.payload_json, '$.sourcePoint.runId') = failed.run_id)
    )`,
  ],
};

const retiredTriggers = [
  "orchestration_v2_thread_references_insert",
  "orchestration_v2_thread_references_update",
  "orchestration_v2_thread_references_delete",
  "orchestration_v2_quiet_turn_items_insert",
  "orchestration_v2_quiet_turn_items_update",
  "orchestration_v2_quiet_messages_insert",
  "orchestration_v2_quiet_messages_update",
];

function scalar(db, query, ...args) {
  const statement = db.prepare(query);
  statement.setReturnArrays(true);
  return statement.get(...args)?.[0];
}

function readSettings(file) {
  let contents;
  try {
    contents = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const settings = JSON.parse(contents);
  NodeAssert.ok(
    settings && typeof settings === "object" && !Array.isArray(settings),
    "Expected a settings object",
  );
  return settings;
}

function readLedgers(db) {
  return Object.fromEntries(
    Object.keys(ledgers).map((table) => {
      const statement = db.prepare(`SELECT migration_id, name FROM ${table} ORDER BY migration_id`);
      statement.setReturnArrays(true);
      return [table, statement.all()];
    }),
  );
}

function validateLedgers(recorded) {
  for (const [table, rows] of Object.entries(recorded)) {
    const fingerprint = NodeCrypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    NodeAssert.ok(
      fingerprint === ledgers[table][rows.length],
      `Unexpected ${table} history (${rows.length} entries). Use the exact legacy fork ledger before converting.`,
    );
  }
}

// A live dry run uses separate bounded statements. The high key caps the scan even as new rows arrive.
function scan(db, table, fields, dryRun) {
  if (!dryRun) return db.prepare(`SELECT ${fields} FROM ${table} AS entry`).get();
  const end = scalar(db, `SELECT max(rowid) FROM ${table}`);
  const nextPage = db.prepare(`SELECT rowid FROM ${table}
    WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 1 OFFSET 1023`);
  const page = db.prepare(
    `SELECT ${fields} FROM ${table} AS entry WHERE entry.rowid > ? AND entry.rowid <= ?`,
  );
  const totals = page.get(0, 0);
  for (let cursor = 0; cursor < end;) {
    const next = nextPage.get(cursor, end)?.rowid ?? end;
    for (const [key, count] of Object.entries(page.get(cursor, next))) totals[key] += count;
    cursor = next;
  }
  return totals;
}

function countRows(db, dryRun) {
  const sum = (where) => `count(CASE WHEN ${where} THEN 1 END)`;
  const eventTypes = forkEvents.map((type) => `'${type}'`).join(", ");
  const withhold = `${appEvent} AND event_type IN (${eventTypes})`;
  const countFields = (table) =>
    [
      "count(*) AS rows",
      ...Object.entries(conversions).flatMap(([name, [target, , where]]) =>
        target === table ? [`${sum(where)} AS ${name}`] : [],
      ),
    ].join(", ");
  return {
    events: scan(
      db,
      events,
      [
        countFields(events),
        ...forkEvents.map(
          (type) => `${sum(`${appEvent} AND event_type = '${type}'`)} AS "${type}"`,
        ),
        `${sum(withhold)} AS withheld`,
      ].join(", "),
      dryRun,
    ),
    runtimeRequests: scan(db, requests, countFields(requests), dryRun),
    messages: scan(db, messages, countFields(messages), dryRun),
    projects: scalar(db, "SELECT count(*) FROM projection_projects"),
    threads: scalar(db, `SELECT count(*) FROM ${threads}`),
    issueLinks: scalar(db, "SELECT count(*) FROM issue_thread_links"),
    sidebarLayouts: scalar(db, "SELECT count(*) FROM sidebar_layout"),
  };
}

function representativeThreads(db) {
  const ids = new Set();
  for (const [table, threadId, where] of Object.values(conversions)) {
    ids.add(
      scalar(
        db,
        `SELECT entry.${threadId} FROM ${table} entry
      WHERE ${where} AND EXISTS (SELECT 1 FROM ${threads} thread
        WHERE thread.thread_id = entry.${threadId} AND thread.deleted_at IS NULL)
      ORDER BY entry.rowid LIMIT 1`,
      ),
    );
  }
  ids.delete(undefined);
  const excluded =
    ids.size === 0 ? "" : `AND thread_id NOT IN (${[...ids].map(() => "?").join(", ")})`;
  const recent = scalar(
    db,
    `SELECT thread_id FROM ${threads}
    WHERE deleted_at IS NULL ${excluded} ORDER BY rowid DESC LIMIT 1`,
    ...ids,
  );
  if (recent !== undefined) ids.add(recent);
  return [...ids];
}

function fingerprints(db, ids) {
  const tables = [threads, messages, requests, "orchestration_v2_projection_turn_items"];
  const projectionPayload = (table) => {
    const conversion = Object.values(conversions).find(([target]) => table === target);
    if (!conversion) return "payload_json";
    const [, , where, replacement] = conversion;
    return `CASE WHEN ${where} THEN ${replacement} ELSE payload_json END`;
  };
  return ids.map((id) => [
    id,
    ...[null, 20].map((limit) => {
      const hash = NodeCrypto.createHash("sha256");
      for (const table of tables) {
        hash.update(table);
        for (const row of db
          .prepare(`SELECT ${projectionPayload(table)} AS payload FROM ${table}
        WHERE thread_id = ? ORDER BY rowid DESC${limit === null ? "" : " LIMIT 20"}`)
          .iterate(id)) {
          hash.update(JSON.stringify(JSON.parse(row.payload)));
          hash.update("\n");
        }
      }
      return hash.digest("hex");
    }),
  ]);
}

async function run(db, mode, settingsPath) {
  NodeAssert.ok(
    !scalar(db, "SELECT 1 FROM sqlite_schema WHERE name = ?", settingsExport),
    "Database was already converted. Run restore-settings to recover the exported preferences.",
  );
  const recorded = readLedgers(db);
  validateLedgers(recorded);
  const settings = readSettings(settingsPath);
  const exported = Object.fromEntries(
    keptSettings.filter((key) => Object.hasOwn(settings, key)).map((key) => [key, settings[key]]),
  );
  const blocked = Object.fromEntries(
    Object.entries(blockers).map(([key, [table, where]]) => [
      key,
      scan(db, table, `count(CASE WHEN ${where} THEN 1 END) AS count`, mode === "dry-run").count,
    ]),
  );
  const before = countRows(db, mode === "dry-run");
  console.log(
    JSON.stringify(
      {
        mode,
        ledgers: Object.fromEntries(
          Object.entries(recorded).map(([table, rows]) => [table, rows.length]),
        ),
        blockers: blocked,
        counts: before,
        settingsKeys: Object.keys(exported),
      },
      null,
      2,
    ),
  );
  NodeAssert.ok(
    Object.values(blocked).every((count) => count === 0),
    "Preflight refused conversion. Resolve the reported work with the legacy fork first.",
  );
  if (mode === "dry-run") return;

  const sample = representativeThreads(db);
  const expected = fingerprints(db, sample);
  const eventHead = scalar(db, `SELECT max(sequence) FROM ${events}`);
  const allocated = scalar(db, "SELECT seq FROM sqlite_sequence WHERE name = ?", events);
  const matchingEvents = `${appEvent} AND event_type IN (${forkEvents.map(() => "?").join(", ")})`;
  db.exec(`CREATE TABLE ${archive} AS SELECT * FROM ${events} WHERE 0`);
  NodeAssert.equal(
    db
      .prepare(`INSERT INTO ${archive} SELECT * FROM ${events} WHERE ${matchingEvents}`)
      .run(...forkEvents).changes,
    before.events.withheld,
  );
  // Retain physical sequences and stream versions so later appends cannot reuse them.
  NodeAssert.equal(
    db
      .prepare(`UPDATE ${events} SET application_event_version = 0 WHERE ${matchingEvents}`)
      .run(...forkEvents).changes,
    before.events.withheld,
  );

  for (const trigger of retiredTriggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);

  const changes = { ...before.events, ...before.runtimeRequests, ...before.messages };
  for (const [name, [table, , where, replacement]] of Object.entries(conversions)) {
    NodeAssert.equal(
      db.prepare(`UPDATE ${table} SET payload_json = ${replacement} WHERE ${where}`).run().changes,
      changes[name],
      name,
    );
  }
  db.exec(`CREATE TABLE ${settingsExport} (payload_json TEXT NOT NULL)`);
  db.prepare(`INSERT INTO ${settingsExport} VALUES (?)`).run(JSON.stringify(exported));

  const after = countRows(db, false);
  for (const [group, value] of Object.entries(before)) {
    if (typeof value === "number") NodeAssert.equal(after[group], value, group);
    else {
      NodeAssert.equal(after[group].rows, value.rows, group);
      for (const [key, count] of Object.entries(after[group])) {
        if (key !== "rows") NodeAssert.equal(count, 0, key);
      }
    }
  }
  NodeAssert.deepEqual(readLedgers(db), recorded);
  NodeAssert.equal(scalar(db, `SELECT count(*) FROM ${archive}`), before.events.withheld);
  NodeAssert.equal(scalar(db, `SELECT max(sequence) FROM ${events}`), eventHead);
  NodeAssert.equal(scalar(db, "SELECT seq FROM sqlite_sequence WHERE name = ?", events), allocated);
  NodeAssert.deepEqual(fingerprints(db, sample), expected);
  const { verifyCandidateThreads } = await import("./verify-candidate-threads.ts");
  await verifyCandidateThreads(db, sample);
  return sample.length;
}

function restore(db, settingsPath) {
  const exported = JSON.parse(scalar(db, `SELECT payload_json FROM ${settingsExport}`));
  if (Object.keys(exported).length === 0) {
    console.log(JSON.stringify({ restored: [] }));
    return;
  }
  const current = readSettings(settingsPath);
  const temp = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(settingsPath), ".fresh-settings-"),
  );
  try {
    const staged = NodePath.join(temp, "settings.json");
    NodeFS.writeFileSync(staged, JSON.stringify({ ...current, ...exported }, null, 2) + "\n", {
      mode: 0o600,
      flush: true,
    });
    NodeFS.renameSync(staged, settingsPath);
  } finally {
    NodeFS.rmSync(temp, { recursive: true });
  }
  console.log(JSON.stringify({ restored: Object.keys(exported) }));
}

async function main() {
  const [mode, stateDir, ...extra] = process.argv.slice(2);
  NodeAssert.ok(
    extra.length === 0 && stateDir && ["dry-run", "convert", "restore-settings"].includes(mode),
    "Usage: node scripts/fork-sync/convert-database.mjs <dry-run|convert|restore-settings> <userdata-directory>",
  );
  const directory = NodeFS.realpathSync(stateDir);
  const filename = NodePath.join(directory, "statev2.sqlite");
  NodeAssert.ok(NodeFS.statSync(filename).isFile(), "Expected an existing statev2.sqlite database");
  const settingsPath = NodePath.join(directory, "settings.json");

  if (mode === "dry-run") {
    using db = new NodeSqlite.DatabaseSync(filename, { readOnly: true, timeout: 250 });
    await run(db, mode, settingsPath);
    return;
  }
  // The server holds this lock even between DB operations. The state DB lock also excludes other clients.
  using owner = new NodeSqlite.DatabaseSync(NodePath.join(directory, "server-owner.sqlite"), {
    timeout: 0,
  });
  owner.exec("BEGIN EXCLUSIVE");
  using db = new NodeSqlite.DatabaseSync(filename, { timeout: 0 });
  db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE");
  if (mode === "restore-settings") {
    restore(db, settingsPath);
  } else {
    const verifiedThreads = await run(db, mode, settingsPath);
    db.exec("COMMIT");
    console.log(JSON.stringify({ converted: true, verifiedThreads }));
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
