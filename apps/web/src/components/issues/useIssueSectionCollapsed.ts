import type { IssueRepositoryRef } from "@t3tools/contracts";
import { useUiStateStore } from "~/uiStateStore";
import { repositoryKey } from "./issueWorkspace.logic";

export function issueSectionKey(scope: IssueRepositoryRef, section: string) {
  return `${repositoryKey(scope.host, scope.repository)}:${section}`;
}

/** Shared across issue surfaces; milestone ids retain their existing persisted keys. */
export function useIssueSectionCollapsed(scope: IssueRepositoryRef, section: string) {
  const key = issueSectionKey(scope, section);
  const collapsed = useUiStateStore((state) => state.issueMilestoneCollapsedById[key] ?? false);
  const setCollapsed = useUiStateStore((state) => state.setIssueMilestoneCollapsed);
  return [collapsed, () => setCollapsed(key, !collapsed)] as const;
}
