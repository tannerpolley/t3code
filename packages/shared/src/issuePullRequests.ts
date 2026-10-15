import type { IssuePullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import { threadPullRequestKeyOf, visibleThreadPullRequests } from "./threadPullRequests.ts";

/** Prefer a synced thread snapshot over cached issue metadata; keep unknown links visible. */
export function issuePullRequests(
  closing: readonly IssuePullRequest[],
  linked: readonly ThreadPullRequestLink[],
): IssuePullRequest[] {
  const result = new Map(closing.map((pr) => [threadPullRequestKeyOf(pr), pr]));
  for (const link of visibleThreadPullRequests(linked)) {
    const key = threadPullRequestKeyOf(link);
    if (link.snapshot === null && result.has(key)) continue;
    result.set(key, {
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
      title: link.snapshot?.title ?? "",
      state: link.snapshot?.state ?? null,
      isDraft: link.snapshot?.isDraft ?? false,
    });
  }
  return [...result.values()];
}
