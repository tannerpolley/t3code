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
  readonly pages: ReadonlyMap<string, IssueListResult>;
}

/** A refreshed page replaces its rows even when GitHub's updatedAt is unchanged (local work,
 * Project fields and dependency state can change independently of that timestamp).
 */
export function acceptIssueListPage(
  current: IssueListSnapshot | null,
  page: IssueListPage,
): IssueListSnapshot | null {
  if (current === null && page.cursor !== null) return null;
  const cursor = page.cursor ?? "";
  const replace = current === null || page.generation > current.generation;
  if (current !== null) {
    if (page.scopeKey !== current.scopeKey || page.generation < current.generation) return current;
    if (replace && page.cursor !== null) return current;
    if (!replace) {
      const previous = current.pages.get(cursor);
      if (previous !== undefined && page.result.fetchedAt <= previous.fetchedAt) return current;
      if (previous === undefined && page.cursor !== current.nextCursor) return current;
    }
  }
  const pages = new Map(replace ? [] : current.pages);
  const previous = pages.get(cursor);
  pages.set(cursor, page.result);
  // A changed continuation invalidates the pages after it, e.g. when the repo now fits on one page.
  if (previous !== undefined && previous.nextCursor !== page.result.nextCursor) {
    let after = false;
    for (const key of pages.keys()) {
      if (after) pages.delete(key);
      if (key === cursor) after = true;
    }
  }
  const issuesByNumber = new Map<number, IssueSummary>();
  const milestonesByNumber = new Map<number, IssueMilestone>();
  for (const result of [...pages.values()].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
    for (const issue of result.issues) {
      const previousIssue = issuesByNumber.get(issue.number);
      if (previousIssue === undefined || issue.updatedAt >= previousIssue.updatedAt)
        issuesByNumber.set(issue.number, issue);
    }
    for (const milestone of result.milestones) milestonesByNumber.set(milestone.number, milestone);
  }
  const last = [...pages.values()].at(-1)!;
  return {
    scopeKey: page.scopeKey,
    generation: page.generation,
    pageCount: pages.size,
    repository: page.result.repository,
    viewer: page.result.viewer,
    fetchedAt: [...pages.values()]
      .map((result) => result.fetchedAt)
      .sort()
      .at(-1)!,
    issues: [...issuesByNumber.values()],
    milestones: [...milestonesByNumber.values()],
    nextCursor: last.nextCursor,
    issuesComplete: last.issuesComplete,
    milestonesComplete: last.milestonesComplete,
    pages,
  };
}
