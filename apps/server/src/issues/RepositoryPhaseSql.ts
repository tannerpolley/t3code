export const repositoryPhaseSql = (payload: string) => `CASE
  WHEN json_type(${payload}, '$.repositoryOrchestration.retiredToThreadId') IS NOT NULL THEN 'retired'
  WHEN json_extract(${payload}, '$.repositoryOrchestration.automaticHandoff.status') = 'verifying' THEN 'handoff_verifying'
  WHEN json_type(${payload}, '$.repositoryOrchestration.restore') = 'object' THEN 'draining'
  WHEN json_extract(${payload}, '$.repositoryOrchestration.handoff.status') = 'draining' THEN 'draining'
  WHEN json_type(${payload}, '$.repositoryOrchestration.handoff') = 'object' THEN 'handoff_awaiting_approval'
  ELSE 'active' END`;
export const repositoryAdmissionSql = (payload: string) =>
  `(${repositoryPhaseSql(payload)} NOT IN ('retired', 'handoff_verifying'))`;
