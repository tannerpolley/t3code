import type { ScopedThreadRef } from "@t3tools/contracts";

import type { IssueSurface } from "~/rightPanelStore";

/** A pull request as both sides name it: the server it is read from, its host, repository and number. */
interface PullRequestTarget {
  readonly environmentId: string;
  /** Unknown on a pull request tab from a server that predates host-scoped tabs. */
  readonly host: string | undefined;
  readonly repository: string;
  readonly number: number;
}

// ponytail: in memory, so a reload forgets which issue opened a pull request tab and its back
// arrow falls back to the thread's pull requests. Persist it beside the surface if that matters.
const origins = new Map<string, { readonly host: string; readonly issue: IssueSurface }>();

const originKey = (threadRef: ScopedThreadRef, pullRequest: PullRequestTarget) =>
  [
    threadRef.environmentId,
    threadRef.threadId,
    pullRequest.environmentId,
    pullRequest.repository.toLowerCase(),
    pullRequest.number,
  ].join("|");

/** Remembers that an issue beside a thread opened this pull request, so back can return to it. */
export function rememberIssueOrigin(
  threadRef: ScopedThreadRef,
  pullRequest: PullRequestTarget & { readonly host: string },
  issue: IssueSurface,
) {
  origins.set(originKey(threadRef, pullRequest), {
    host: pullRequest.host.toLowerCase(),
    issue,
  });
}

/** The issue that opened this pull request beside the thread, while its tab is still open. */
export function issueOriginFor(
  threadRef: ScopedThreadRef,
  pullRequest: PullRequestTarget,
  openSurfaceIds: ReadonlyArray<string>,
): IssueSurface | null {
  const origin = origins.get(originKey(threadRef, pullRequest));
  if (origin === undefined || !openSurfaceIds.includes(origin.issue.id)) return null;
  return pullRequest.host === undefined || pullRequest.host.toLowerCase() === origin.host
    ? origin.issue
    : null;
}
