import type { EnvironmentId, IssueRepositoryRef } from "@t3tools/contracts";
import { useUiStateStore } from "~/uiStateStore";
import { repositoryKey } from "./issueWorkspace.logic";

type IssueSectionScope = IssueRepositoryRef & { readonly environmentId: EnvironmentId };

export function issueSectionKey(scope: IssueSectionScope, section: string) {
  return `${scope.environmentId}:${repositoryKey(scope.host, scope.repository)}:${section}`;
}

export function issueSectionCollapsedSelector(scope: IssueSectionScope, section: string) {
  const key = issueSectionKey(scope, section);
  const legacyKey = `${repositoryKey(scope.host, scope.repository)}:${section}`;
  return (state: { readonly issueMilestoneCollapsedById: Readonly<Record<string, boolean>> }) =>
    state.issueMilestoneCollapsedById[key] ??
    (section.startsWith("milestone:") ? state.issueMilestoneCollapsedById[legacyKey] : false) ??
    false;
}

/** Shared across issue surfaces; old milestone choices remain readable until overridden. */
export function useIssueSectionCollapsed(scope: IssueSectionScope, section: string) {
  const key = issueSectionKey(scope, section);
  const collapsed = useUiStateStore(issueSectionCollapsedSelector(scope, section));
  const setCollapsed = useUiStateStore((state) => state.setIssueMilestoneCollapsed);
  return [collapsed, () => setCollapsed(key, !collapsed)] as const;
}
