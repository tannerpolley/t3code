import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Legacy comments inherited their issue's source, so only a fresh marker check can classify them.
  yield* sql`UPDATE issue_inbox_repositories AS r SET
    comments_since = MIN(comments_since, COALESCE((
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MIN(e.occurred_at), '-5 minutes')
      FROM issue_inbox_events e WHERE e.host = r.host AND e.repository_id = r.repository_id
        AND e.kind = 'comment' AND e.read_at IS NULL
    ), comments_since)), comments_etag = NULL`;
  yield* sql`DELETE FROM issue_inbox_events WHERE kind = 'comment' AND read_at IS NULL`;
  yield* sql`UPDATE issue_inbox_events SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE read_at IS NULL AND (
      kind <> 'issue_opened' OR source_project IS NULL OR source_project = ''
    )`;
  // Retire unsent stale text without counting it as a successful notification.
  yield* sql`DELETE FROM issue_inbox_digests WHERE delivered_at IS NULL`;
  yield* sql`ALTER TABLE issue_inbox_events ADD COLUMN digest_id INTEGER`;
  // Only successful digests count as announced; turn-start notes may never have reached a provider.
  yield* sql`UPDATE issue_inbox_events SET digest_id = (
    SELECT d.digest_id FROM issue_inbox_digests d
    WHERE issue_inbox_events.noted_by = 'digest:' || d.digest_id
      AND d.host = issue_inbox_events.host AND d.repository_id = issue_inbox_events.repository_id
  )`;
  yield* sql`ALTER TABLE issue_inbox_events DROP COLUMN noted_by`;
  yield* sql`CREATE UNIQUE INDEX issue_inbox_digests_pending
    ON issue_inbox_digests(host, repository_id) WHERE delivered_at IS NULL`;
  yield* sql`DROP TABLE issue_inbox_own_writes`;
  yield* sql`DROP TABLE issue_inbox_write_receipts`;
});
