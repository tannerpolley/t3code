import { threadIssueRepository } from "@t3tools/client-runtime/state/issue-work";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { useProjects, useThreadShell } from "~/state/entities";

export function useIssuePageScope() {
  const threadRef = useThreadRouteRef();
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const project = projects.find(
    (project) =>
      project.id === thread?.projectId && project.environmentId === threadRef?.environmentId,
  );
  const scope = threadIssueRepository(project?.repositoryIdentity);
  return scope && threadRef
    ? { ...scope, environmentId: threadRef.environmentId, originThreadId: threadRef.threadId }
    : {};
}
