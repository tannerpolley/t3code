import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_repository_orchestration (
      host TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      root_thread_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      workspace TEXT NOT NULL CHECK (workspace IN ('project', 'worktree')),
      launch_command_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      worker_limit INTEGER NOT NULL CHECK (worker_limit BETWEEN 1 AND 32),
      publish_status_comments INTEGER NOT NULL CHECK (publish_status_comments IN (0, 1)),
      publish_closeout_comments INTEGER NOT NULL CHECK (publish_closeout_comments IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, repository_id)
    ) WITHOUT ROWID
  `;

  // Preview builds may already have the explicit root field in thread JSON. Rebuild
  // from that durable payload; never infer repository ownership from project remotes.
  yield* sql`
    INSERT INTO orchestration_v2_projection_repository_orchestration (
      host, repository_id, repository, root_thread_id, project_id, workspace,
      launch_command_id, revision, paused, worker_limit, publish_status_comments,
      publish_closeout_comments, created_at, updated_at
    )
    SELECT
      json_extract(payload_json, '$.repositoryOrchestration.host'),
      json_extract(payload_json, '$.repositoryOrchestration.repositoryId'),
      json_extract(payload_json, '$.repositoryOrchestration.repository'),
      thread_id,
      json_extract(payload_json, '$.repositoryOrchestration.projectId'),
      json_extract(payload_json, '$.repositoryOrchestration.workspace'),
      json_extract(payload_json, '$.repositoryOrchestration.launchCommandId'),
      json_extract(payload_json, '$.repositoryOrchestration.revision'),
      json_extract(payload_json, '$.repositoryOrchestration.paused'),
      json_extract(payload_json, '$.repositoryOrchestration.workerLimit'),
      json_extract(payload_json, '$.repositoryOrchestration.publishStatusComments'),
      json_extract(payload_json, '$.repositoryOrchestration.publishCloseoutComments'),
      created_at,
      updated_at
    FROM orchestration_v2_projection_threads
    WHERE json_type(payload_json, '$.repositoryOrchestration') = 'object'
    ON CONFLICT(host, repository_id) DO NOTHING
  `;
});
