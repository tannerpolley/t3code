import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A legacy close-out also disposed nested deliveries. Only the attempt's task updated its node or card.
  yield* sql`
    WITH closed_out_tasks AS MATERIALIZED (
      SELECT event.stream_id AS parent_id,
        json_extract(event.payload_json, '$.id') AS task_id,
        json_extract(event.payload_json, '$.childThreadId') AS worker_id,
        json_extract(event.payload_json, '$.completedAt') AS completed_at
      FROM orchestration_command_receipts receipt
      CROSS JOIN orchestration_events event INDEXED BY idx_orch_events_command_id
        ON event.command_id = receipt.command_id
        AND event.event_type = 'subagent.updated'
        AND event.aggregate_kind = 'thread' AND event.application_event_version = 2
      WHERE receipt.command_type = 'issue.work.close-out' AND receipt.status = 'accepted'
        AND EXISTS (
          SELECT 1 FROM orchestration_events related
          WHERE related.command_id = event.command_id AND related.stream_id = event.stream_id
            AND related.sequence > event.sequence
            AND ((related.event_type = 'node.updated'
                AND json_extract(related.payload_json, '$.id') = json_extract(event.payload_json, '$.id'))
              OR (related.event_type = 'turn-item.updated'
                AND json_extract(related.payload_json, '$.subagentId') = json_extract(event.payload_json, '$.id')))
        )
    )
    UPDATE orchestration_v2_projection_subagents AS task
    SET payload_json = json_set(task.payload_json, '$.issueAttemptClosedOut', json('true'))
    WHERE (task.subagent_id, task.thread_id, task.child_thread_id, task.completed_at) IN (
      SELECT task_id, parent_id, worker_id, completed_at FROM closed_out_tasks
    )
      AND task.origin = 'app_owned' AND task.status = 'completed'
      AND task.completion_delivery_state = 'disposed'
  `;
});
