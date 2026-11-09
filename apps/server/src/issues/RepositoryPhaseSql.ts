export const repositoryPhaseSql = (payload: string) => `CASE
  WHEN json_extract(${payload}, '$.repositoryOrchestration.retiredToThreadId') IS NOT NULL THEN 'retired'
  WHEN json_extract(${payload}, '$.repositoryOrchestration.handoff.status') = 'draining' THEN 'draining'
  WHEN json_type(${payload}, '$.repositoryOrchestration.handoff') = 'object' THEN 'handoff_awaiting_approval'
  WHEN coalesce(json_extract(${payload}, '$.repositoryOrchestration.paused'), 0) <> 0 THEN 'paused'
  ELSE 'active' END`;
// The owner projection supplies paused for managed admissions, as it did before phase naming.
export const repositoryAdmissionSql = (
  payload: string,
  paused = `coalesce(json_extract(${payload}, '$.repositoryOrchestration.paused'), 0)`,
) => `(json_extract(${payload}, '$.repositoryOrchestration.retiredToThreadId') IS NULL
  AND (${paused} = 0 OR json_extract(${payload}, '$.repositoryOrchestration.handoff.status') = 'draining'))`;
