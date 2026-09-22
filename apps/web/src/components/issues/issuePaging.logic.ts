import type { IssueListResult, IssueMilestone, IssueSummary } from "@t3tools/contracts";

export interface IssueListPage {
  readonly scopeKey: string;
  readonly generation: number;
  readonly cursor: string | null;
  readonly result: IssueListResult;
}

export interface IssueListSnapshot {
  readonly scopeKey: string;
  readonly generation: number;
  readonly pageCount: number;
  readonly repository: IssueListResult["repository"];
  readonly viewer: IssueListResult["viewer"];
  readonly fetchedAt: string;
  readonly issues: readonly IssueSummary[];
  readonly milestones: readonly IssueMilestone[];
  readonly nextCursor: string | null;
  readonly issuesComplete: boolean;
  readonly milestonesComplete: boolean;
  readonly acceptedCursors: ReadonlySet<string>;
}

function newestIssue(left: IssueSummary | undefined, right: IssueSummary): IssueSummary {
  return left === undefined || right.updatedAt >= left.updatedAt ? right : left;
}

export function acceptIssueListPage(
  current: IssueListSnapshot | null,
  page: IssueListPage,
): IssueListSnapshot | null {
  if (current === null && page.cursor !== null) return null;
  if (current !== null) {
    if (page.scopeKey !== current.scopeKey || page.generation < current.generation) return current;
    if (page.generation > current.generation && page.cursor !== null) return current;
    if (
      page.generation === current.generation &&
      (page.cursor === null
        ? current.pageCount > 0
        : page.cursor !== current.nextCursor || current.acceptedCursors.has(page.cursor))
    ) {
      return current;
    }
  }

  const replace = current === null || page.cursor === null || page.generation > current.generation;
  const previousIssues = replace ? [] : current.issues;
  const issuesByNumber = new Map<number, IssueSummary>(
    previousIssues.map((issue) => [issue.number, issue]),
  );
  for (const issue of page.result.issues) {
    issuesByNumber.set(issue.number, newestIssue(issuesByNumber.get(issue.number), issue));
  }

  const previousMilestones = replace ? [] : current.milestones;
  const milestonesByNumber = new Map<number, IssueMilestone>(
    previousMilestones.map((milestone) => [milestone.number, milestone]),
  );
  for (const milestone of page.result.milestones) {
    milestonesByNumber.set(milestone.number, milestone);
  }

  return {
    scopeKey: page.scopeKey,
    generation: page.generation,
    pageCount: replace ? 1 : current.pageCount + 1,
    repository: page.result.repository,
    viewer: page.result.viewer,
    fetchedAt: page.result.fetchedAt,
    issues: [...issuesByNumber.values()],
    milestones: [...milestonesByNumber.values()],
    nextCursor: page.result.nextCursor,
    issuesComplete: page.result.issuesComplete,
    milestonesComplete: page.result.milestonesComplete,
    acceptedCursors: new Set([...(replace ? [] : current.acceptedCursors), page.cursor ?? ""]),
  };
}
