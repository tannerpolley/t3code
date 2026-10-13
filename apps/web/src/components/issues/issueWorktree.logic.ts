import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { threadIssueRepository } from "../chat/ThreadDetailsIssueRows";
import { repositoryKey } from "./issueWorkspace.logic";

/** `issue-<number>-<title slug>`: one ref segment, lowercase, git-safe. */
export function issueWorktreeBranchName(number: number, title: string): string {
  return sanitizeBranchFragment(`issue-${number}-${title.replaceAll("/", " ")}`);
}

interface IssueProjectCandidate {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/**
 * The project to start an issue's work in: one in the issue's environment whose fork or upstream
 * repository is the issue's, preferring the project the reader came from.
 */
export function findIssueProject<T extends IssueProjectCandidate>(
  projects: ReadonlyArray<T>,
  issue: {
    readonly environmentId: EnvironmentId;
    readonly host: string;
    readonly repository: string;
  },
  preferredProjectId: ProjectId | null,
): T | null {
  const wanted = repositoryKey(issue.host, issue.repository);
  const matches = projects.filter((project) => {
    if (project.environmentId !== issue.environmentId) return false;
    const fork = threadIssueRepository(project.repositoryIdentity);
    if (fork === null) return false;
    const upstream = sourceControlRepositorySelector(project.repositoryIdentity);
    return (
      repositoryKey(fork.host, fork.repository) === wanted ||
      (upstream !== null && repositoryKey(fork.host, upstream) === wanted)
    );
  });
  return matches.find((project) => project.id === preferredProjectId) ?? matches[0] ?? null;
}
