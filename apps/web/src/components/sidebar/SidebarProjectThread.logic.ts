import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { resolveThreadPullRequestBadge } from "@t3tools/client-runtime/thread-pull-requests";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

/** Checkout assignment from stored paths; preparation never claims the project root. */
export function sidebarProjectThreadCheckout(input: {
  readonly worktreePath: string | null;
  readonly projectPath: string | undefined;
  readonly preparingWorktree: boolean;
}) {
  const worktreePath = input.worktreePath?.trim();
  if (worktreePath) {
    return { label: `Worktree ${fileBasename(worktreePath)}`, path: worktreePath };
  }
  return input.preparingWorktree
    ? { label: "Preparing worktree", path: null }
    : { label: "Project checkout", path: input.projectPath ?? null };
}

/** Only persisted snapshots contribute a state or count; unsynced links cannot imply open. */
export function sidebarProjectThreadPullRequests(links: ReadonlyArray<ThreadPullRequestLink>) {
  const badge = resolveThreadPullRequestBadge(links.filter((link) => link.snapshot !== null));
  if (badge === null) return null;
  const count = badge.kind === "stack" ? badge.layers : badge.others + 1;
  const presentation = PULL_REQUEST_STATE_PRESENTATION[badge.state];
  return {
    ...presentation,
    count,
    label: `${count} pull ${count === 1 ? "request" : "requests"}, ${presentation.label.toLowerCase()} (last recorded)`,
  };
}

/**
 * A row's accessible name: the button's label hides its glyphs' labels, so it carries what they
 * show (the role title the row shows instead of the thread's name, the issue, PR state).
 */
export function sidebarProjectThreadAccessibleName(input: {
  readonly role?: string | undefined;
  readonly title: string;
  readonly issueNumber?: number | undefined;
  readonly status: string;
  readonly links: ReadonlyArray<ThreadPullRequestLink>;
}) {
  const pullRequests = sidebarProjectThreadPullRequests(input.links);
  return [
    input.role,
    input.title,
    input.issueNumber === undefined ? undefined : `issue #${input.issueNumber}`,
    input.status,
    pullRequests?.label,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}
