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
  // Retire stale digest text, retaining its timestamp so the notification throttle survives upgrade.
  yield* sql`UPDATE issue_inbox_events SET noted_by = NULL WHERE read_at IS NULL AND noted_by IN (
    SELECT 'digest:' || digest_id FROM issue_inbox_digests WHERE delivered_at IS NULL
  )`;
  yield* sql`UPDATE issue_inbox_digests SET delivered_at = created_at WHERE delivered_at IS NULL`;
  yield* sql`DROP TABLE issue_inbox_own_writes`;
  yield* sql`DROP TABLE issue_inbox_write_receipts`;
});
