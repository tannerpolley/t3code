import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One watcher cursor per managed repository. `watched_since` bounds which issues and comments are new.
  yield* sql`CREATE TABLE issue_inbox_repositories (
    host TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    watched_since TEXT NOT NULL,
    issues_since TEXT NOT NULL,
    comments_since TEXT NOT NULL,
    events_after INTEGER,
    issues_etag TEXT,
    comments_etag TEXT,
    events_etag TEXT,
    PRIMARY KEY (host, repository_id)
  ) WITHOUT ROWID`;
  // Issues the watcher has listed: titles for comment events, and whether the issue is external
  // (`external_source` set, empty when no project is named) and has had its receiver labels.
  yield* sql`CREATE TABLE issue_inbox_issues (
    host TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    cross_project INTEGER NOT NULL,
    external_source TEXT,
    labeled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (host, repository_id, issue_number)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE issue_inbox_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    event_key TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    kind TEXT NOT NULL,
    author TEXT,
    source_project TEXT,
    tagged INTEGER NOT NULL,
    high_priority INTEGER NOT NULL,
    needs_triage INTEGER NOT NULL,
    url TEXT NOT NULL,
    snippet TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    read_at TEXT,
    noted_by TEXT,
    UNIQUE (host, repository_id, event_key)
  )`;
  yield* sql`CREATE INDEX issue_inbox_events_unread ON issue_inbox_events(host, repository_id, event_id) WHERE read_at IS NULL`;
  // Durable digest outbox: written before dispatch, retried until delivered.
  yield* sql`CREATE TABLE issue_inbox_digests (
    digest_id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`;
  yield* sql`CREATE INDEX issue_inbox_digests_repository ON issue_inbox_digests(host, repository_id, created_at)`;
  // Same-project t3_issue_post writes carry no marker; these receipts (`issue:<number>`,
  // `comment:<id>`) mark them as the repository's own.
  yield* sql`CREATE TABLE issue_inbox_own_writes (
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (host, repository, item)
  ) WITHOUT ROWID`;
  // A state or milestone transition T3 wrote, with the GitHub request's time span in epoch
  // milliseconds. The watcher deletes a receipt when one event matches it.
  yield* sql`CREATE TABLE issue_inbox_write_receipts (
    receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    milestone_number INTEGER,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX issue_inbox_write_receipts_issue ON issue_inbox_write_receipts(host, repository, issue_number)`;
});
