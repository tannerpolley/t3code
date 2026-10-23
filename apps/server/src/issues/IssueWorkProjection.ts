import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { threadErrorSummary } from "@t3tools/shared/orchestrationV2ThreadError";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const workThread = OrchestrationV2AppThreadJson.mapFields(
  ({
    id,
    title,
    role,
    branch,
    worktreePath,
    lineage,
    linkedIssue,
    linkedPullRequest,
    pullRequests,
    archivedAt,
    deletedAt,
    activeProviderThreadId,
  }) => ({
    id,
    title,
    role,
    branch,
    worktreePath,
    lineage,
    linkedIssue,
    linkedPullRequest,
    pullRequests,
    archivedAt,
    deletedAt,
    activeProviderThreadId,
  }),
);
const workRun = OrchestrationV2RunJson.mapFields(({ id, ordinal, status }) => ({
  id,
  ordinal,
  status,
}));
const providerWork = OrchestrationV2ProviderThreadJson.mapFields(
  ({ id, pendingBackgroundTasks }) => ({ id, pendingBackgroundTasks }),
);
const decodeThread = Schema.decodeEffect(Schema.fromJsonString(workThread));
const decodeRun = Schema.decodeEffect(Schema.fromJsonString(Schema.NullOr(workRun)));
const decodeFailure = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2ProviderFailure));
const decodeProviders = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(providerWork)));
const decodeItems = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.Literals(["command_execution", "dynamic_tool", "subagent"]),
        status: Schema.Literals([
          "pending",
          "running",
          "waiting",
          "completed",
          "interrupted",
          "failed",
          "cancelled",
        ]),
        title: Schema.NullOr(Schema.String),
        input: Schema.Unknown,
      }),
    ),
  ),
);

export type IssueWorkThread = typeof workThread.Type &
  Pick<OrchestrationV2ThreadShell, "status" | "activityRunStatus" | "pendingBackgroundTasks"> & {
    readonly pendingRuntimeRequest: {
      readonly kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"];
    } | null;
  };

/** The issue pane needs work state, not message previews, timeline counts or fork history. */
export const readIssueWorkThreads = Effect.fn("IssueLinks.readWorkProjection")(function* (
  sql: SqlClient.SqlClient,
  threadIds: readonly ThreadId[],
) {
  if (threadIds.length === 0) return [];
  const rows = yield* sql<{
    thread_json: string;
    run_json: string;
    blocked_run_json: string;
    blocked_failure: string | null;
    session_error: string | null;
    activity_status: IssueWorkThread["activityRunStatus"];
    active: number;
    request_kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"] | null;
    request_blocking: number | null;
    secret: number;
    native_status: IssueWorkThread["status"] | "pending" | null;
    provider_work: string;
    item_work: string;
  }>`
    SELECT json_patch(json_object(
      'id', t.thread_id, 'title', t.title,
      'branch', json_extract(t.payload_json, '$.branch'),
      'worktreePath', json_extract(t.payload_json, '$.worktreePath'),
      'lineage', json_extract(t.payload_json, '$.lineage'),
      'archivedAt', t.archived_at, 'deletedAt', t.deleted_at,
      'activeProviderThreadId', json_extract(t.payload_json, '$.activeProviderThreadId')
    ), json_object(
      'role', json_extract(t.payload_json, '$.role'),
      'linkedIssue', json_extract(t.payload_json, '$.linkedIssue'),
      'linkedPullRequest', json_extract(t.payload_json, '$.linkedPullRequest'),
      'pullRequests', json_extract(t.payload_json, '$.pullRequests')
    )) AS thread_json,
    coalesce((SELECT json_object('id', r.run_id, 'ordinal', r.ordinal, 'status', r.status)
      FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
        AND NOT (r.status = 'queued' AND json_extract(r.payload_json, '$.queueHeld') IS 1)
      ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1), 'null') AS run_json,
    CASE WHEN blocked.run_id IS NULL THEN 'null' ELSE json_object(
      'id', blocked.run_id, 'ordinal', blocked.ordinal, 'status', blocked.status) END AS blocked_run_json,
    (SELECT json_extract(item.payload_json, '$.failure')
      FROM orchestration_v2_projection_turn_items item
      WHERE item.thread_id = t.thread_id AND item.run_id = blocked.run_id
        AND item.type = 'error' AND item.status = 'failed'
        AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
      ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC LIMIT 1) AS blocked_failure,
    CASE WHEN blocked.run_id IS NOT NULL THEN (
      SELECT json_extract(session.payload_json, '$.lastError')
      FROM orchestration_v2_projection_provider_session_bindings binding
      CROSS JOIN orchestration_v2_projection_provider_sessions session
        ON session.provider_session_id = binding.provider_session_id
      WHERE binding.thread_id = t.thread_id AND session.provider_instance_id = t.provider_instance_id
      ORDER BY session.updated_at DESC, session.provider_session_id DESC LIMIT 1
    ) END AS session_error,
    (SELECT r.status FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'starting', 'running', 'waiting')
      ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1) AS activity_status,
    EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
      AND r.status IN ('preparing', 'starting', 'running')) AS active,
    json_extract(request.payload_json, '$.kind') AS request_kind,
    json_extract(request.payload_json, '$.responseCapability.type') IS NOT 'message' AS request_blocking,
    EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r
      CROSS JOIN orchestration_v2_projection_turn_items item
        INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
      WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'starting', 'running', 'waiting')
        AND item.thread_id = t.thread_id AND item.run_id = r.run_id
        AND item.type = 'secret_request' AND item.status = 'waiting'
        AND json_extract(item.payload_json, '$.nodeId') IS NOT NULL) AS secret,
    (SELECT subagent.status FROM orchestration_v2_projection_subagents subagent
      WHERE subagent.child_thread_id = t.thread_id AND subagent.origin = 'provider_native'
      ORDER BY subagent.updated_at DESC, subagent.subagent_id DESC LIMIT 1) AS native_status,
    (SELECT json_group_array(json_object('id', p.provider_thread_id,
      'pendingBackgroundTasks', json(coalesce(json_extract(p.payload_json, '$.pendingBackgroundTasks'), '[]'))))
      FROM orchestration_v2_projection_provider_threads p WHERE p.thread_id = t.thread_id) AS provider_work,
    (SELECT json_group_array(json_object('id', i.turn_item_id, 'type', i.type, 'status', i.status,
      'title', json_extract(i.payload_json, '$.title'), 'input', json_extract(i.payload_json, '$.input')))
      FROM orchestration_v2_projection_turn_items i
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.thread_id = t.thread_id AND i.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
        AND (i.run_id IS NULL OR r.status <> 'rolled_back')) AS item_work
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
      SELECT r.run_id FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = t.thread_id AND r.status <> 'queued'
        AND NOT (r.status = 'cancelled' AND json_extract(r.payload_json, '$.startedAt') IS NULL)
      ORDER BY r.completed_at IS NULL DESC, r.completed_at DESC, r.ordinal DESC, r.run_id DESC LIMIT 1
    ) AND blocked.status = 'failed'
    LEFT JOIN orchestration_v2_projection_runtime_requests request ON request.runtime_request_id = (
      SELECT pending.runtime_request_id FROM orchestration_v2_projection_runtime_requests pending
      WHERE pending.thread_id = t.thread_id AND pending.status = 'pending'
      ORDER BY pending.created_at DESC, pending.runtime_request_id DESC LIMIT 1)
    WHERE t.thread_id IN ${sql.in(threadIds)} AND t.deleted_at IS NULL
    ORDER BY t.thread_id
  `;
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const thread = yield* decodeThread(row.thread_json);
      const latest = yield* decodeRun(row.run_json);
      const blocked = yield* decodeRun(row.blocked_run_json);
      const failure =
        row.blocked_failure === null
          ? null
          : yield* decodeFailure(row.blocked_failure).pipe(Effect.orElseSucceed(() => null));
      const run =
        blocked !== null &&
        threadErrorSummary(failure, row.session_error).lastErrorClass === "usage_limit"
          ? blocked
          : latest;
      const providers = yield* decodeProviders(row.provider_work);
      const items = yield* decodeItems(row.item_work);
      const pending =
        row.secret === 1 && (row.request_kind === null || row.request_blocking === 0)
          ? "user_input"
          : row.request_kind;
      const native = run === null && pending === null ? row.native_status : null;
      const status = run?.status ?? (native === "pending" ? "starting" : native) ?? "idle";
      return {
        ...thread,
        status,
        activityRunStatus:
          row.activity_status ??
          (native === "pending"
            ? "starting"
            : native === "running" || native === "waiting"
              ? native
              : null),
        pendingRuntimeRequest: pending === null ? null : { kind: pending },
        pendingBackgroundTasks: derivePendingBackgroundWork({
          latestRun: run,
          providerThreads: providers,
          turnItems: items,
          activeProviderThreadId: thread.activeProviderThreadId,
          hasActiveRun: row.active === 1,
          pullRequests: thread.pullRequests,
        }),
      };
    }),
  );
});
