import type { ScopedThreadRef } from "@t3tools/contracts";

import type { IssueSurface } from "~/rightPanelStore";

// ponytail: in memory, so a reload forgets which issue opened a pull request tab and its back
// arrow falls back to the thread's pull requests. Persist it beside the surface if that matters.
const origins = new Map<string, IssueSurface>();

const originKey = (
  threadRef: ScopedThreadRef,
  pullRequest: { readonly repository: string; readonly number: number },
) =>
  `${threadRef.environmentId}:${threadRef.threadId}|${pullRequest.repository.toLowerCase()}#${pullRequest.number}`;

/** Remembers that an issue beside a thread opened this pull request, so back can return to it. */
export function rememberIssueOrigin(
  threadRef: ScopedThreadRef,
  pullRequest: { readonly repository: string; readonly number: number },
  issue: IssueSurface,
) {
  origins.set(originKey(threadRef, pullRequest), issue);
}

/** The issue that opened this pull request beside the thread, while its tab is still open. */
export function issueOriginFor(
  threadRef: ScopedThreadRef,
  pullRequest: { readonly repository: string; readonly number: number },
  openSurfaceIds: ReadonlyArray<string>,
): IssueSurface | null {
  const origin = origins.get(originKey(threadRef, pullRequest));
  return origin !== undefined && openSurfaceIds.includes(origin.id) ? origin : null;
}
