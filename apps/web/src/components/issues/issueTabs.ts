import type {
  EnvironmentId,
  ProjectId,
  RepositoryIssueRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useRightPanelStore, type IssueSurfaceTarget } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { findIssueProject } from "./issueWorktree.logic";

/** A roadmap row's GitHub issue, as the fork's issue reads name it. */
export interface RepositoryIssueTarget {
  readonly environmentId?: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url?: string;
}

/** The GitHub issue an upstream issue tab names, or null for another tracker's. */
export function repositoryIssueOf(surface: {
  readonly tracker: string;
  readonly host?: string | undefined;
  readonly scope: string;
  readonly key: string;
}): RepositoryIssueRef | null {
  const number = Number(surface.key);
  if (surface.tracker !== "github" || !Number.isSafeInteger(number) || number < 1) return null;
  return { host: (surface.host ?? "github.com").toLowerCase(), repository: surface.scope, number };
}

/**
 * Upstream's issue tab for a roadmap row. Upstream reads an issue through a project, so a row
 * whose repository has no project in its environment has no tab.
 */
export function issueTabTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  issue: RepositoryIssueTarget & { readonly environmentId: string },
  preferredProjectId: ProjectId | null = null,
): IssueSurfaceTarget | null {
  const project = findIssueProject(
    projects,
    { ...issue, environmentId: issue.environmentId as EnvironmentId },
    preferredProjectId,
  );
  if (project === null) return null;
  return {
    environmentId: issue.environmentId,
    projectId: project.id,
    tracker: "github",
    host: issue.host.toLowerCase(),
    scope: issue.repository,
    key: String(issue.number),
    ...(issue.url === undefined ? {} : { url: issue.url }),
  };
}

/** Opens a roadmap row's issue tab beside `ref`; a repository with no project here opens on GitHub. */
export function useOpenIssueTab() {
  const projects = useProjects();
  return (
    ref: ScopedThreadRef,
    issue: RepositoryIssueTarget & { readonly environmentId: string },
    preferredProjectId: ProjectId | null = null,
  ) => {
    const tab = issueTabTarget(projects, issue, preferredProjectId);
    if (tab !== null) useRightPanelStore.getState().openIssue(ref, tab);
    else if (issue.url) window.open(issue.url, "_blank", "noopener,noreferrer");
  };
}
