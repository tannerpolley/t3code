import type { IssueSummary } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CirclePauseIcon,
  CircleSlashIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type IssueStateInput = Pick<IssueSummary, "state"> &
  Partial<Pick<IssueSummary, "stateReason" | "projects">> & {
    readonly liveWork?:
      | readonly Pick<NonNullable<IssueSummary["liveWork"]>[number], "status">[]
      | undefined;
    readonly blockedBy?:
      | readonly Pick<NonNullable<IssueSummary["blockedBy"]>[number], "state">[]
      | undefined;
    readonly pullRequests?:
      | readonly Pick<NonNullable<IssueSummary["pullRequests"]>[number], "state">[]
      | undefined;
    /** In the repository's issue queue, waiting for its orchestrator to start it. */
    readonly queued?: boolean | undefined;
  };

export type IssueProgress =
  | "completed"
  | "not_planned"
  | "blocked"
  | "in_progress"
  | "queued"
  | "paused"
  | "open";

/**
 * Closed wins, split the way GitHub closes an issue: not planned (or a duplicate) apart from
 * completed, which is also what an issue closed without a reason counts as. Then an open
 * blocker. In progress means an agent is on it now, working or waiting for the owner; then queued
 * for its orchestrator; work without either (an open or draft pull request, an idle linked
 * thread) is paused. Project fields
 * are metadata only.
 */
export function issueProgress<T extends IssueStateInput>(issue: T): IssueProgress {
  if (issue.state === "closed")
    return issue.stateReason === "not_planned" || issue.stateReason === "duplicate"
      ? "not_planned"
      : "completed";
  if (issue.blockedBy?.some((blocker) => blocker.state === "open")) return "blocked";
  const work = issue.liveWork ?? [];
  if (work.some((entry) => entry.status === "working" || entry.status === "waiting_on_you"))
    return "in_progress";
  if (issue.queued) return "queued";
  if (work.length > 0 || issue.pullRequests?.some((pr) => pr.state === "open")) return "paused";
  return "open";
}

/** Tones match the pull request glyphs: open green, done purple, shelved gray, failing red. */
export const ISSUE_PROGRESS_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    badgeVariant: "success",
    Icon: CircleDotIcon,
  },
  in_progress: {
    label: "In progress",
    toneClassName: "text-sky-600 dark:text-sky-300/90",
    badgeVariant: "info",
    Icon: CircleDotDashedIcon,
  },
  queued: {
    label: "Queued",
    toneClassName: "text-indigo-600 dark:text-indigo-300/90",
    badgeVariant: "secondary",
    Icon: CircleEllipsisIcon,
  },
  paused: {
    label: "Paused",
    toneClassName: "text-amber-600 dark:text-amber-300/90",
    badgeVariant: "warning",
    Icon: CirclePauseIcon,
  },
  blocked: {
    label: "Blocked",
    toneClassName: "text-red-600 dark:text-red-300/90",
    badgeVariant: "error",
    Icon: CircleAlertIcon,
  },
  completed: {
    label: "Closed as completed",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    badgeVariant: "outline",
    Icon: CircleCheckIcon,
  },
  not_planned: {
    label: "Closed as not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    badgeVariant: "secondary",
    Icon: CircleSlashIcon,
  },
} as const;

export function issueStatePresentation(issue: IssueStateInput) {
  const presentation = ISSUE_PROGRESS_PRESENTATION[issueProgress(issue)];
  return issue.stateReason === "duplicate"
    ? { ...presentation, label: "Closed as duplicate" }
    : presentation;
}

/** An issue's state glyph with its name on hover, as the pull request rows draw theirs. */
export function IssueStateIcon({
  issue,
  className,
}: {
  readonly issue: IssueStateInput;
  readonly className?: string;
}) {
  const presentation = issueStatePresentation(issue);
  return (
    <Tooltip>
      {/* A span trigger: rows are buttons, and a nested control would steal their click. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}
