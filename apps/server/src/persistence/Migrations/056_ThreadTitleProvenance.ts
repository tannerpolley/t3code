import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Backfills `titleSource` so automatic retitling never replaces a title a person typed.
 * A title is the user's when its latest change came from a client rename: a
 * `thread.metadata.update` that is not an agent's MCP rename (`command:mcp:` ids). A change
 * with no receipt is treated the same way, as is a V1 import's title that never changed.
 * Everything else (creation and launch titles, first-message titles, regenerations, agent
 * renames) is generated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH title_events AS (
      SELECT
        stream_id,
        sequence,
        command_id,
        json_extract(payload_json, '$.title') AS title,
        LAG(json_extract(payload_json, '$.title')) OVER (
          PARTITION BY stream_id ORDER BY sequence
        ) AS previous_title
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND event_type IN ('thread.created', 'thread.metadata-updated')
    ),
    latest_title_changes AS (
      SELECT
        stream_id,
        command_id,
        ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence DESC) AS position
      FROM title_events
      WHERE previous_title IS NOT NULL
        AND title IS NOT previous_title
    ),
    title_owners AS (
      SELECT change.stream_id
      FROM latest_title_changes change
      LEFT JOIN orchestration_command_receipts receipt
        ON receipt.command_id = change.command_id
      WHERE change.position = 1
        AND (
          receipt.command_type IS NULL
          OR (
            receipt.command_type = 'thread.metadata.update'
            AND change.command_id NOT LIKE 'command:mcp:%'
          )
        )
    )
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(
      thread.payload_json,
      '$.titleSource',
      CASE
        WHEN thread.thread_id IN (SELECT stream_id FROM title_owners) THEN 'user'
        WHEN json_extract(thread.payload_json, '$.historyOrigin') = 'v1_import'
          AND thread.thread_id NOT IN (SELECT stream_id FROM latest_title_changes)
          THEN 'user'
        ELSE 'generated'
      END
    )
    WHERE json_extract(thread.payload_json, '$.titleSource') IS NULL
  `;
});
