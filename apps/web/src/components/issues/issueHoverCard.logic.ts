import type {
  IssueDetailResult,
  IssuePullRequest,
  IssueSummary,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { issuePullRequests } from "@t3tools/source-control-definitions/issuePullRequests";

/** Issue reads lack branch topology; empty branches keep the thread list from inferring chains. */
function miniListLink(pr: IssuePullRequest, observedAt: string): ThreadPullRequestLink {
  return {
    host: pr.host,
    repository: pr.repository,
    number: pr.number,
    url: pr.url,
    source: "manual",
    linkedAt: observedAt,
    stack: null,
    snapshot:
      pr.state === null
        ? null
        : {
            state: pr.state,
            title: pr.title || pr.repository,
            isDraft: pr.isDraft,
            updatedAt: pr.updatedAt ?? null,
            syncedAt: observedAt,
            headBranch: "",
            baseBranch: "",
          },
  };
}

export function issueHoverPullRequests(
  issue: IssueSummary,
  host: string,
  detail: IssueDetailResult | null,
) {
  const observedAt = detail?.fetchedAt ?? issue.updatedAt;
  const mentioned = (detail?.linkedPullRequests ?? []).map((pr) => ({ ...pr, host }));
  const linked = (issue.pullRequests ?? []).map((pr) => miniListLink(pr, observedAt));
  return issuePullRequests(mentioned, linked).map((pr) => miniListLink(pr, observedAt));
}
