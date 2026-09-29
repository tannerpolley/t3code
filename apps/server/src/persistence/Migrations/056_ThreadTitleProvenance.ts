import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
        title,
        command_id,
        ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY sequence DESC) AS position
      FROM title_events
      WHERE previous_title IS NOT NULL
        AND title IS NOT previous_title
    )
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(
      thread.payload_json,
      '$.titleSource',
      CASE WHEN EXISTS (
        SELECT 1
        FROM latest_title_changes change
        WHERE change.stream_id = thread.thread_id
          AND change.position = 1
          AND change.title IS json_extract(thread.payload_json, '$.title')
          AND change.command_id LIKE '%:title-complete'
      ) THEN 'generated' ELSE 'user' END
    )
    WHERE json_extract(thread.payload_json, '$.titleSource') IS NULL
  `;
});
