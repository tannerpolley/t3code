import type { IssueRepositoryRef } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

/** Closed issues retain archived workers; fork migration 017 indexes both active and archived rows. */
export const issueWorkThreadIds = (
  sql: SqlClient.SqlClient,
  scope: IssueRepositoryRef,
  issueNumbers: readonly number[],
  linkedThreadIds: readonly string[],
  prRefsJson: string,
  hasPrRefs: boolean,
  includeArchived = false,
) => sql<{
  thread_id: string;
  pr_repository: string | null;
  pr_number: number | null;
  pr_url: string | null;
}>`
  WITH RECURSIVE linked(thread_id) AS (
    SELECT issue_thread.thread_id FROM orchestration_v2_projection_threads issue_thread
    WHERE issue_thread.deleted_at IS NULL AND (${includeArchived} OR issue_thread.archived_at IS NULL)
      AND lower(CASE WHEN json_valid(issue_thread.payload_json) THEN json_extract(issue_thread.payload_json, '$.linkedIssue.host') END) = ${scope.host.toLowerCase()}
      AND lower(CASE WHEN json_valid(issue_thread.payload_json) THEN json_extract(issue_thread.payload_json, '$.linkedIssue.repository') END) = ${scope.repository.toLowerCase()}
      AND CASE WHEN json_valid(issue_thread.payload_json) THEN json_extract(issue_thread.payload_json, '$.linkedIssue.number') END IN ${sql.in(issueNumbers)}
    ${
      linkedThreadIds.length === 0
        ? sql``
        : sql`UNION
    SELECT explicit.thread_id FROM orchestration_v2_projection_threads explicit
    WHERE explicit.deleted_at IS NULL AND (${includeArchived} OR explicit.archived_at IS NULL)
      AND explicit.thread_id IN ${sql.in(linkedThreadIds)}`
    }
    ${
      hasPrRefs
        ? sql`UNION
    SELECT pr_thread.thread_id FROM json_each(${prRefsJson}) ref
    CROSS JOIN orchestration_v2_projection_threads pr_thread
    WHERE pr_thread.deleted_at IS NULL AND (${includeArchived} OR pr_thread.archived_at IS NULL)
      AND CASE WHEN json_valid(pr_thread.payload_json) THEN json_extract(pr_thread.payload_json, '$.linkedPullRequest.number') END IS NOT NULL
      AND lower(CASE WHEN json_valid(pr_thread.payload_json) THEN json_extract(pr_thread.payload_json, '$.linkedPullRequest.repository') END) = lower(json_extract(ref.value, '$.repository'))
      AND CASE WHEN json_valid(pr_thread.payload_json) THEN json_extract(pr_thread.payload_json, '$.linkedPullRequest.number') END = json_extract(ref.value, '$.number')`
        : sql``
    }
    UNION
    SELECT child.thread_id FROM linked
    -- Without stats (Sqlite.ts deletes them) the planner prefers the deleted_at index and scans every thread per row.
    CROSS JOIN orchestration_v2_projection_threads child
      -- Remove the seed's TEXT affinity so SQLite can search the JSON expression index.
      ON CASE WHEN json_valid(child.payload_json) THEN json_extract(child.payload_json, '$.lineage.parentThreadId') END = +linked.thread_id
    WHERE child.deleted_at IS NULL AND (${includeArchived} OR child.archived_at IS NULL)
  )
  SELECT linked.thread_id,
    CASE WHEN json_valid(selected.payload_json) THEN json_extract(selected.payload_json, '$.linkedPullRequest.repository') END AS pr_repository,
    CASE WHEN json_valid(selected.payload_json) THEN json_extract(selected.payload_json, '$.linkedPullRequest.number') END AS pr_number,
    json_extract(selected.payload_json, '$.linkedPullRequest.url') AS pr_url
  FROM linked CROSS JOIN orchestration_v2_projection_threads selected
  WHERE selected.thread_id = linked.thread_id
  ORDER BY linked.thread_id
`;
