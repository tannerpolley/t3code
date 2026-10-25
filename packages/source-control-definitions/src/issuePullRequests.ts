import type {
  IssuePullRequest,
  IssuePullRequestStatus,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";
import { builtInSourceControlDefinitions } from "./registry.ts";

const { threadPullRequestKeyOf } = makeThreadPullRequests(builtInSourceControlDefinitions);

/** Order host observations by update time, with terminal states winning when time is unknown. */
export function issuePullRequests(
  closing: readonly IssuePullRequest[],
  linked: readonly ThreadPullRequestLink[],
): IssuePullRequest[];
export function issuePullRequests(
  closing: readonly IssuePullRequestStatus[],
  linked: readonly ThreadPullRequestLink[],
): IssuePullRequestStatus[];
export function issuePullRequests(
  closing: readonly IssuePullRequestStatus[],
  linked: readonly ThreadPullRequestLink[],
): IssuePullRequestStatus[] {
  const result = new Map<string, IssuePullRequestStatus>(
    closing.map((pr) => [threadPullRequestKeyOf(pr), pr]),
  );
  for (const link of visibleThreadPullRequests(linked)) {
    const key = threadPullRequestKeyOf(link);
    const previous = result.get(key);
    if (link.snapshot === null && previous !== undefined) continue;
    const candidate: IssuePullRequest = {
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
      title: link.snapshot?.title ?? "",
      state: link.snapshot?.state ?? null,
      isDraft: link.snapshot?.isDraft ?? false,
      ...(link.snapshot?.updatedAt == null ? {} : { updatedAt: link.snapshot.updatedAt }),
    };
    if (previous !== undefined) {
      const before = previous.updatedAt == null ? NaN : Date.parse(previous.updatedAt);
      const after = candidate.updatedAt == null ? NaN : Date.parse(candidate.updatedAt);
      if (Number.isFinite(before) && Number.isFinite(after) && before !== after) {
        if (before > after) continue;
      } else if (
        (previous.state === "merged" || previous.state === "closed") &&
        candidate.state !== "merged" &&
        candidate.state !== "closed"
      )
        continue;
    }
    result.set(key, candidate);
  }
  return [...result.values()];
}
