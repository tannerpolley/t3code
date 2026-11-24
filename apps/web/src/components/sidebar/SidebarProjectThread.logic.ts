import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { resolveThreadPullRequestBadge } from "@t3tools/client-runtime/thread-pull-requests";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

/** Checkout assignment from stored paths; preparation never claims the project root. */
export function sidebarProjectThreadCheckout(
  input: {
    readonly worktreePath: string | null;
    readonly projectPath: string | undefined;
    readonly preparingWorktree: boolean;
  },
  resolve: MessageResolver = m,
) {
  const worktreePath = input.worktreePath?.trim();
  if (worktreePath) {
    return {
      label: resolve(msg("Worktree {name}", { name: fileBasename(worktreePath) })),
      path: worktreePath,
    };
  }
  return input.preparingWorktree
    ? { label: resolve(msg("Preparing worktree")), path: null }
    : { label: resolve(msg("Project checkout")), path: input.projectPath ?? null };
}

const PR_STATE_LABELS = {
  open: msg("open", { $context: "pull request state" }),
  draft: msg("draft", { $context: "pull request state" }),
  closed: msg("closed", { $context: "pull request state" }),
  merged: msg("merged", { $context: "pull request state" }),
};

/** Only persisted snapshots contribute a state or count; unsynced links cannot imply open. */
export function sidebarProjectThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
  resolve: MessageResolver = m,
) {
  const badge = resolveThreadPullRequestBadge(links.filter((link) => link.snapshot !== null));
  if (badge === null) return null;
  const count = badge.kind === "stack" ? badge.layers : badge.others + 1;
  const presentation = PULL_REQUEST_STATE_PRESENTATION[badge.state];
  return {
    ...presentation,
    count,
    label: resolve(
      msg(
        "{count, plural, one {{count} pull request, {state} (last recorded)} other {{count} pull requests, {state} (last recorded)}}",
        {
          count,
          state: resolve(PR_STATE_LABELS[badge.state]),
        },
      ),
    ),
  };
}

/**
 * A row's accessible name: the button's label hides its glyphs' labels, so it carries what they
 * show (the role title the row shows instead of the thread's name, the issue, PR state).
 */
export function sidebarProjectThreadAccessibleName(
  input: {
    readonly role?: string | undefined;
    readonly title: string;
    readonly issueNumber?: number | undefined;
    readonly status: string;
    readonly links: ReadonlyArray<ThreadPullRequestLink>;
  },
  resolve: MessageResolver = m,
) {
  const pullRequests = sidebarProjectThreadPullRequests(input.links, resolve);
  return [
    input.role,
    input.title,
    input.issueNumber === undefined
      ? undefined
      : resolve(msg("issue #{number}", { number: input.issueNumber })),
    input.status,
    pullRequests?.label,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}
