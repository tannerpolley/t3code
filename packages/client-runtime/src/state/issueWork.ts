import {
  ISSUE_WORK_STATUS_LABELS,
  type EnvironmentId,
  type IssueWorkStartResult,
  type IssueWorkStatusResult,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { sourceControlClients } from "../sourceControlClients.ts";

export function supportsIssueHost(identity: RepositoryIdentity | null | undefined) {
  return identity?.provider === "github" || identity?.provider === "forgejo";
}

/** Issues belong to the checkout's origin, including when pull requests target upstream. */
export function threadIssueRepository(identity: RepositoryIdentity | null | undefined) {
  if (!identity || !supportsIssueHost(identity)) return null;
  const repository =
    identity.origin?.displayName ?? sourceControlClients.repositorySelector(identity);
  const host = sourceControlClients.changeRequestHost(identity, identity.provider);
  return host === undefined ||
    repository === null ||
    (identity.provider === "github" && host !== "github.com")
    ? null
    : { host, repository };
}

/** Match the owning environment and fork/upstream, preferring the reader's project. */
export function findIssueProject<
  T extends {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  },
>(
  projects: ReadonlyArray<T>,
  issue: {
    readonly environmentId: EnvironmentId;
    readonly host: string;
    readonly repository: string;
  },
  preferredProjectId: ProjectId | null,
): T | null {
  const matches = projects.filter((project) => {
    if (project.environmentId !== issue.environmentId) return false;
    const fork = threadIssueRepository(project.repositoryIdentity);
    if (fork === null || fork.host.toLowerCase() !== issue.host.toLowerCase()) return false;
    const upstream = sourceControlClients.repositorySelector(project.repositoryIdentity);
    const wanted = issue.repository.toLowerCase();
    return fork.repository.toLowerCase() === wanted || upstream?.toLowerCase() === wanted;
  });
  return matches.find((project) => project.id === preferredProjectId) ?? matches[0] ?? null;
}

/** Present the server's current owner, never infer ownership or completion from historical threads. */
export function issueWorkPresentation(
  status: IssueWorkStatusResult | null,
  accepted: IssueWorkStartResult | null = null,
) {
  const current = status?.status != null ? status : accepted;
  const workStatus = current?.status ?? null;
  const workerId =
    current === status ? (status?.threadId ?? null) : (accepted?.issueThreadId ?? null);
  const threadId = workerId ?? (workStatus === null ? null : (current?.rootThreadId ?? null));
  return {
    threadId,
    isWorker: workerId !== null,
    label: workStatus === null ? null : ISSUE_WORK_STATUS_LABELS[workStatus],
    publishingLabel:
      status?.publishing === "pending"
        ? "GitHub update pending"
        : status?.publishing === "failed"
          ? "GitHub update failed · retry pending"
          : null,
  };
}
