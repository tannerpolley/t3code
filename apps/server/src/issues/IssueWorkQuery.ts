import type { IssueRepositoryRef } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

/** Keep the expression and active-row predicates aligned with IssueRoadmapIndexesMigration. */
export const issueWorkThreadIds = (
  sql: SqlClient.SqlClient,
  scope: IssueRepositoryRef,
  issueNumbers: readonly number[],
  linkedThreadIds: readonly string[],
  prRefsJson: string,
  hasPrRefs: boolean,
) => sql<{
  thread_id: string;
  pr_repository: string | null;
  pr_number: number | null;
  pr_url: string | null;
}>`
  WITH RECURSIVE linked(thread_id) AS (
    SELECT issue_thread.thread_id FROM orchestration_v2_projection_threads issue_thread
    WHERE issue_thread.deleted_at IS NULL AND issue_thread.archived_at IS NULL
      AND lower(json_extract(issue_thread.payload_json, '$.linkedIssue.host')) = ${scope.host.toLowerCase()}
      AND lower(json_extract(issue_thread.payload_json, '$.linkedIssue.repository')) = ${scope.repository.toLowerCase()}
      AND json_extract(issue_thread.payload_json, '$.linkedIssue.number') IN ${sql.in(issueNumbers)}
    ${
      linkedThreadIds.length === 0
        ? sql``
        : sql`UNION
    SELECT explicit.thread_id FROM orchestration_v2_projection_threads explicit
    WHERE explicit.deleted_at IS NULL AND explicit.archived_at IS NULL
      AND explicit.thread_id IN ${sql.in(linkedThreadIds)}`
    }
    ${
      hasPrRefs
        ? sql`UNION
    SELECT pr_thread.thread_id FROM json_each(${prRefsJson}) ref
    CROSS JOIN orchestration_v2_projection_threads pr_thread
    WHERE pr_thread.deleted_at IS NULL AND pr_thread.archived_at IS NULL
      AND json_extract(pr_thread.payload_json, '$.linkedPullRequest.number') IS NOT NULL
      AND lower(json_extract(pr_thread.payload_json, '$.linkedPullRequest.repository')) = lower(json_extract(ref.value, '$.repository'))
      AND json_extract(pr_thread.payload_json, '$.linkedPullRequest.number') = json_extract(ref.value, '$.number')`
        : sql``
    }
    UNION
    SELECT child.thread_id FROM linked
    JOIN orchestration_v2_projection_threads child
      -- Remove the seed's TEXT affinity so SQLite can search the JSON expression index.
      ON json_extract(child.payload_json, '$.lineage.parentThreadId') = +linked.thread_id
    WHERE child.deleted_at IS NULL AND child.archived_at IS NULL
  )
  SELECT linked.thread_id,
    json_extract(selected.payload_json, '$.linkedPullRequest.repository') AS pr_repository,
    json_extract(selected.payload_json, '$.linkedPullRequest.number') AS pr_number,
    json_extract(selected.payload_json, '$.linkedPullRequest.url') AS pr_url
  FROM linked CROSS JOIN orchestration_v2_projection_threads selected
  WHERE selected.thread_id = linked.thread_id
  ORDER BY linked.thread_id
`;
